import { describe, expect, test } from "vitest";
import {
	type PickedFile,
	ResumeUploadError,
	validateResume,
} from "#/lib/resume.ts";

function picked(over: Partial<PickedFile> = {}): PickedFile {
	return {
		bytes: new Uint8Array([1, 2, 3]),
		filename: "cv.docx",
		mimeType: "application/octet-stream",
		...over,
	};
}

describe("validateResume", () => {
	test("derives the canonical MIME type from the extension", () => {
		expect(validateResume(picked({ filename: "cv.docx" }))).toBe(
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		);
		expect(validateResume(picked({ filename: "cv.pdf" }))).toBe(
			"application/pdf",
		);
	});

	test("rejects an empty file", () => {
		expect(() => validateResume(picked({ bytes: new Uint8Array() }))).toThrow(
			ResumeUploadError,
		);
	});

	test("rejects an unsupported type", () => {
		try {
			validateResume(picked({ filename: "cv.txt" }));
			throw new Error("expected validateResume to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(ResumeUploadError);
			expect((err as ResumeUploadError).code).toBe("unsupported-type");
		}
	});

	test("rejects a file over the size cap", () => {
		const tooBig = picked({
			bytes: new Uint8Array(10 * 1024 * 1024 + 1),
			filename: "cv.pdf",
		});
		try {
			validateResume(tooBig);
			throw new Error("expected validateResume to throw");
		} catch (err) {
			expect((err as ResumeUploadError).code).toBe("too-large");
		}
	});
});
