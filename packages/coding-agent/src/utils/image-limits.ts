/** Maximum inline image payload accepted by the image input pipeline. */
export const MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;

/** Initialization-order-safe accessor for modules participating in import cycles. */
export function getMaxImageInputBytes(): number {
	return 20 * 1024 * 1024;
}
