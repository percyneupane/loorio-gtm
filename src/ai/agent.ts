import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { z } from 'zod';
import type { Config } from '../config.ts';
import type { DraftEmail } from '../outreach/schedule.ts';
import type { Creator, EmailCandidate } from '../repo/creators.ts';
import {
  DraftSchema,
  QUALIFY_SYSTEM,
  QualifySchema,
  ReplySchema,
  TRIAGE_SYSTEM,
  TriageSchema,
  draftSystem,
  replySystem,
  type Qualification,
  type Triage,
} from './prompts.ts';

export const PITCH_PATH = 'config/pitch.md';

/** Everything the app asks of Claude. An interface so tests can use a deterministic fake. */
export interface Agent {
  qualify(creator: Creator, context: string, candidates: readonly EmailCandidate[]): Promise<Qualification>;
  draftSequence(creator: Creator, hook: string, followUps: number): Promise<DraftEmail[]>;
  triage(email: { from: string; subject: string; text: string; isOutreachThread: boolean }): Promise<Triage>;
  draftReply(thread: string, creator: Creator | undefined): Promise<string>;
}

/** Models with server-side refusal fallback (`fallbacks: "default"`) on the Claude API. */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);

export function readPitch(): string {
  try {
    return fs.readFileSync(PITCH_PATH, 'utf8');
  } catch {
    throw new Error(`Missing ${PITCH_PATH} — it describes Loorio and the ask for every email`);
  }
}

function creatorBlock(creator: Creator, extra = ''): string {
  return `<creator>
Name: ${creator.name}
First name: ${creator.first_name ?? 'unknown'}
Platform: ${creator.platform} (@${creator.handle})
Followers: ${creator.followers ?? 'unknown'}
Bio: ${creator.bio.slice(0, 1000)}
${extra}
</creator>`;
}

export function createAgent(config: Config): Agent {
  const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

  async function structured<S extends z.ZodType>(opts: {
    model: string;
    system: string;
    user: string;
    schema: S;
    effort: 'low' | 'medium' | 'high';
    maxTokens: number;
  }): Promise<z.infer<S>> {
    const withFallback = FALLBACK_MODELS.has(opts.model);
    const response = await client.beta.messages.parse({
      model: opts.model,
      max_tokens: opts.maxTokens,
      system: opts.system,
      messages: [{ role: 'user', content: opts.user }],
      output_config: { effort: opts.effort, format: betaZodOutputFormat(opts.schema) },
      ...(withFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    });
    if (response.stop_reason === 'refusal') {
      throw new Error(`Claude declined this request (${response.stop_details?.category ?? 'no category'})`);
    }
    if (response.stop_reason === 'max_tokens') throw new Error('Claude response was cut off (max_tokens)');
    if (!response.parsed_output) throw new Error('Claude returned output that did not match the schema');
    return response.parsed_output as z.infer<S>;
  }

  return {
    async qualify(creator, context, candidates) {
      const list = candidates.length
        ? candidates.map((c, i) => `${i + 1}. ${c.email} — found in ${c.source_label}: "${c.snippet}"`).join('\n')
        : '(none found)';
      const result = await structured({
        model: config.MODEL_FAST,
        system: QUALIFY_SYSTEM,
        user: `<profile>\n${creatorBlock(creator)}\n${context}\n</profile>\n\nCandidate emails:\n${list}`,
        schema: QualifySchema,
        effort: 'low',
        maxTokens: 4000,
      });
      const allowed = new Set(candidates.map((c) => c.email));
      const email = result.email?.trim().toLowerCase() ?? null;
      return {
        ...result,
        email: email && allowed.has(email) ? email : null,
        fitScore: Math.max(0, Math.min(100, Math.round(result.fitScore))),
      };
    },

    async draftSequence(creator, hook, followUps) {
      const result = await structured({
        model: config.MODEL_WRITER,
        system: draftSystem(readPitch(), followUps, config.SENDER_NAME),
        user: `${creatorBlock(creator, `Detail to reference: ${hook}\nContext:\n${creator.context.slice(0, 3000)}`)}\n\nWrite the ${followUps + 1} emails.`,
        schema: DraftSchema,
        effort: 'medium',
        maxTokens: 16000,
      });
      const emails = result.emails.filter((e) => e.subject.trim() && e.body.trim());
      if (emails.length === 0) throw new Error('Claude returned no usable emails');
      return emails;
    },

    async triage(email) {
      return structured({
        model: config.MODEL_FAST,
        system: TRIAGE_SYSTEM,
        user: `${email.isOutreachThread ? 'This message is in a thread where the founder emailed a creator first.\n' : ''}<email>\nFrom: ${email.from}\nSubject: ${email.subject}\n\n${email.text.slice(0, 6000)}\n</email>`,
        schema: TriageSchema,
        effort: 'low',
        maxTokens: 2000,
      });
    },

    async draftReply(thread, creator) {
      const about = creator ? `\n\nThe sender is a creator you contacted:\n${creatorBlock(creator)}` : '';
      const result = await structured({
        model: config.MODEL_WRITER,
        system: replySystem(readPitch(), config.SENDER_NAME, config.SENDER_TITLE),
        user: `<thread>\n${thread.slice(0, 20000)}\n</thread>${about}\n\nDraft the founder's reply to the latest message.`,
        schema: ReplySchema,
        effort: 'medium',
        maxTokens: 8000,
      });
      return result.body.trim();
    },
  };
}
