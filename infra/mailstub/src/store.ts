import { randomUUID } from 'node:crypto';

export interface Attachment {
  readonly filename: string;
  readonly contentType: string;
  readonly content: Buffer;
}

export interface StoredMessage {
  readonly id: string;
  readonly messageId: string | null;
  readonly receivedAt: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly html: string | null;
  readonly attachments: readonly Attachment[];
}

export type NewMessage = Omit<StoredMessage, 'id' | 'receivedAt'>;

export interface MailStore {
  /** Adds a message. A message whose Message-ID was seen before is dropped: the same mail is never shown twice. */
  readonly add: (message: NewMessage) => { readonly stored: boolean; readonly id: string };
  readonly list: (filter: { readonly to?: string | undefined; readonly q?: string | undefined }) => readonly StoredMessage[];
  readonly get: (id: string) => StoredMessage | undefined;
  readonly clear: () => void;
}

/** In-memory inbox, newest first, capped so a long run cannot exhaust memory. */
export const createStore = (capacity = 5_000): MailStore => {
  let messages: StoredMessage[] = [];
  const seen = new Map<string, string>();
  return {
    add: (message) => {
      if (message.messageId !== null) {
        const known = seen.get(message.messageId);
        if (known) return { stored: false, id: known };
      }
      const stored: StoredMessage = { ...message, id: randomUUID(), receivedAt: new Date().toISOString() };
      messages = [stored, ...messages].slice(0, capacity);
      if (message.messageId !== null) seen.set(message.messageId, stored.id);
      return { stored: true, id: stored.id };
    },
    list: ({ to, q }) =>
      messages.filter((m) => (to === undefined || m.to.some((t) => t.toLowerCase() === to.toLowerCase())) && (q === undefined || `${m.subject} ${m.text}`.toLowerCase().includes(q.toLowerCase()))),
    get: (id) => messages.find((m) => m.id === id),
    clear: () => {
      messages = [];
      seen.clear();
    },
  };
};
