/**
 * T-064 — what a resume actually is, decided from its bytes.
 *
 * **The client's `Content-Type` is not evidence.** It is a string the uploader
 * chose, and an attacker chooses `application/pdf` for an HTML file with a
 * script in it as readily as for a PDF. Every accepted type here is confirmed
 * from the leading bytes of the file, and a file whose bytes do not match any
 * entry is rejected outright rather than stored as `application/octet-stream`.
 *
 * The allowlist is short on purpose: PDF and the two Word formats are what a
 * resume arrives as. Adding to it is a decision, not a convenience.
 */

export const MAX_RESUME_BYTES = 10 * 1024 * 1024;

export interface ResumeContentType {
  readonly contentType: string;
  readonly extension: string;
}

interface Signature extends ResumeContentType {
  readonly magic: readonly number[];
  /** Where the signature starts. Non-zero for formats with a header. */
  readonly offset: number;
}

/*
 * `%PDF-`, and the ZIP local-file header `PK\x03\x04` that both modern Office
 * formats are containers for.
 *
 * DOCX and XLSX share that header byte-for-byte, so the signature alone
 * cannot separate them — `detectResumeContentType` resolves the ambiguity
 * below rather than pretending the bytes did.
 */
const SIGNATURES: readonly Signature[] = [
  {
    magic: [0x25, 0x50, 0x44, 0x46, 0x2d],
    offset: 0,
    contentType: 'application/pdf',
    extension: 'pdf',
  },
  {
    magic: [0x50, 0x4b, 0x03, 0x04],
    offset: 0,
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: 'docx',
  },
  /* The OLE2 compound-document header — legacy .doc. */
  {
    magic: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
    offset: 0,
    contentType: 'application/msword',
    extension: 'doc',
  },
];

export class UnsupportedResumeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedResumeError';
  }
}

function matches(bytes: Buffer, signature: Signature): boolean {
  if (bytes.length < signature.offset + signature.magic.length) return false;
  return signature.magic.every((byte, index) => bytes[signature.offset + index] === byte);
}

/**
 * A DOCX is a ZIP containing `word/document.xml`. Scanning the first part of
 * the archive for that path separates it from any other ZIP — an XLSX, or a
 * renamed archive of something else entirely.
 *
 * Deliberately a substring scan and not a ZIP parse: parsing untrusted
 * archives is its own attack surface (zip bombs, path traversal in entries),
 * and all that is needed here is a yes/no on one well-known name.
 */
function looksLikeDocx(bytes: Buffer): boolean {
  const window = bytes.subarray(0, Math.min(bytes.length, 4096));
  return window.includes('word/');
}

/**
 * @throws {UnsupportedResumeError} when the bytes match nothing on the list.
 */
export function detectResumeContentType(bytes: Buffer): ResumeContentType {
  for (const signature of SIGNATURES) {
    if (!matches(bytes, signature)) continue;

    if (signature.extension === 'docx' && !looksLikeDocx(bytes)) {
      throw new UnsupportedResumeError(
        'the file is a ZIP archive but not a Word document. Upload a PDF or a .docx.',
      );
    }
    return { contentType: signature.contentType, extension: signature.extension };
  }

  throw new UnsupportedResumeError('unrecognised file type. Upload a PDF, a .docx, or a .doc.');
}

/**
 * Storage keys are built here and never from the uploaded filename (SEC-043).
 *
 * The original name is kept in the database for display and contributes
 * nothing to the path: a filename is attacker-controlled, and `../` in one is
 * how an upload becomes a write anywhere on the volume. The extension comes
 * from the detected type, not from the name either.
 */
export function resumeStorageKey(
  companyId: string,
  candidateId: string,
  resumeId: string,
  extension: string,
): string {
  return `resumes/${companyId}/${candidateId}/${resumeId}.${extension}`;
}

/** The frozen per-application copy lives beside the application, not the profile. */
export function applicationResumeKey(
  companyId: string,
  applicationId: string,
  resumeId: string,
  extension: string,
): string {
  return `applications/${companyId}/${applicationId}/${resumeId}.${extension}`;
}

/** Recovers the extension from a key this module wrote. Falls back to `bin`. */
export function extensionOf(storageKey: string): string {
  const lastDot = storageKey.lastIndexOf('.');
  if (lastDot === -1) return 'bin';
  const extension = storageKey.slice(lastDot + 1);
  return /^[a-z0-9]{1,8}$/.test(extension) ? extension : 'bin';
}
