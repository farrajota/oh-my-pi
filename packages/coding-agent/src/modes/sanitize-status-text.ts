import { sanitizeText } from "@oh-my-pi/pi-utils";

/** Sanitize text for display in a single-line status. */
export function sanitizeStatusText(text: string): string {
	return sanitizeText(text)
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}
