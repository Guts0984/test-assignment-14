import { simpleParser, type AddressObject } from 'mailparser';
import { SMTPServer } from 'smtp-server';
import type { MailStore } from './store.js';

const addresses = (field: AddressObject | AddressObject[] | undefined): string[] => {
  if (!field) return [];
  return (Array.isArray(field) ? field : [field]).flatMap((f) => f.value.map((v) => v.address ?? '')).filter(Boolean);
};

/** Accepts any mail over SMTP (no auth, no TLS) and files it in the store. */
export const startSmtp = (store: MailStore, port: number): Promise<{ readonly port: number; readonly close: () => Promise<void> }> =>
  new Promise((resolve, reject) => {
    const server = new SMTPServer({
      authOptional: true,
      disabledCommands: ['STARTTLS', 'AUTH'],
      size: 20 * 1024 * 1024,
      onData(stream, _session, callback) {
        simpleParser(stream)
          .then((mail) => {
            store.add({
              messageId: mail.messageId ?? null,
              from: addresses(mail.from).join(', '),
              to: addresses(mail.to),
              subject: mail.subject ?? '',
              text: mail.text ?? '',
              html: typeof mail.html === 'string' ? mail.html : null,
              attachments: mail.attachments.map((a) => ({ filename: a.filename ?? 'attachment', contentType: a.contentType, content: a.content })),
            });
            callback();
          })
          .catch((error: unknown) => callback(error instanceof Error ? error : new Error(String(error))));
      },
    });
    server.on('error', reject);
    server.listen(port, '0.0.0.0', () => {
      const address = server.server.address();
      resolve({ port: typeof address === 'object' && address ? address.port : port, close: () => new Promise<void>((done) => server.close(() => done())) });
    });
  });
