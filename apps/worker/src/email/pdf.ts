import PDFDocument from 'pdfkit';
import { toBuffer } from 'qrcode';

export interface PdfTicket {
  readonly id: string;
  readonly code: string;
  readonly title: string;
  readonly venue: string;
  readonly startsAt: Date;
  readonly zone: string;
  readonly row: string | null;
  readonly seat: number | null;
}

/** One A5 page per ticket: details and a QR image of the server-signed code. */
export const renderTicketsPdf = async (tickets: readonly PdfTicket[]): Promise<Buffer> => {
  const doc = new PDFDocument({ size: 'A5', margin: 36, info: { Title: 'Tickets' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  for (const [index, t] of tickets.entries()) {
    if (index > 0) doc.addPage();
    doc.fontSize(20).text(t.title, { align: 'left' });
    doc.moveDown(0.3).fontSize(12).text(`${t.venue}`).text(t.startsAt.toISOString().replace('T', ' ').slice(0, 16) + ' UTC');
    doc.moveDown().fontSize(14).text(t.row && t.seat ? `${t.zone} - row ${t.row}, seat ${t.seat}` : `${t.zone} - general admission`);
    const qr = await toBuffer(t.code, { errorCorrectionLevel: 'M', margin: 1, width: 300 });
    doc.image(qr, { fit: [260, 260], align: 'center' });
    doc.moveDown().fontSize(8).fillColor('#555555').text(`Ticket ${t.id}`);
  }
  doc.end();
  return done;
};
