import { Document, Packer, Paragraph, TextRun } from "docx";

/**
 * Turn an approved cover-letter's plain text into a Word (.docx) document, ready to
 * upload as a board "supporting document" alongside the résumé (PNET ApplyExpress has
 * no cover-letter text field — only a file-upload slot). The stored letters stop at the
 * sign-off ("Kind regards,"), so the signatory's name is appended on the next line.
 */

/**
 * Append the signatory's name after the letter's sign-off, unless it's already the
 * last line (idempotent, case-insensitive). The letter text is otherwise untouched.
 */
export function signCoverLetter(content: string, signatory: string): string {
  const text = content.trim();
  const lastLine = (text.split("\n").pop() ?? "").trim();
  if (lastLine.toLowerCase() === signatory.trim().toLowerCase()) return text;
  return `${text}\n${signatory.trim()}`;
}

/**
 * Split signed letter text into docx paragraphs: a blank line starts a new paragraph;
 * a single newline (the sign-off block) becomes a soft line break within one.
 */
function toParagraphs(text: string): Paragraph[] {
  return text.split(/\n{2,}/).map((block) => {
    const lines = block.split("\n");
    return new Paragraph({
      children: lines.map((line, i) => new TextRun(i === 0 ? line : { text: line, break: 1 })),
    });
  });
}

/** Render the cover letter to a .docx (OOXML) byte buffer. */
export async function renderCoverLetterDocx(content: string, signatory: string): Promise<Buffer> {
  const doc = new Document({
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } }, // 11pt
    sections: [{ children: toParagraphs(signCoverLetter(content, signatory)) }],
  });
  return await Packer.toBuffer(doc);
}
