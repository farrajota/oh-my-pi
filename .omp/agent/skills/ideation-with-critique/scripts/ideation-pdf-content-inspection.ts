import * as mupdf from "mupdf";

export const PDF_CONTENT_BOUNDS_TOLERANCE_POINTS = 1;

interface Bounds {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

interface BlockCounts {
  readonly text: number;
  readonly image: number;
  readonly vector: number;
  readonly total: number;
}

export interface PdfContentPageInspection {
  readonly page_index: number;
  readonly bounds: Bounds;
  readonly content_bounds: Bounds;
  readonly block_counts: BlockCounts;
  readonly text_byte_count: number;
  readonly out_of_bounds_count: number;
  readonly maximum_overflow: number;
  readonly clipped: boolean;
}

export interface PdfContentInspection {
  readonly page_count: number;
  readonly pages: readonly PdfContentPageInspection[];
  readonly extracted_text: string;
  readonly extracted_text_byte_count: number;
}

type Rect = readonly [number, number, number, number];
type BlockKind = "text" | "image" | "vector";

function finiteRect(value: Rect, label: string): Bounds {
  if (value.length !== 4 || value.some(entry => !Number.isFinite(entry)) || value[2] < value[0] || value[3] < value[1]) {
    throw new TypeError(`PDF_CONTENT_BOUNDS_INVALID:${label}`);
  }
  return Object.freeze({ x0: value[0], y0: value[1], x1: value[2], y1: value[3] });
}

function intersectRect(first: Rect, second: Rect): Rect | null {
  const intersection: Rect = [Math.max(first[0], second[0]), Math.max(first[1], second[1]), Math.min(first[2], second[2]), Math.min(first[3], second[3])];
  return intersection[2] < intersection[0] || intersection[3] < intersection[1] ? null : intersection;
}


function unionBounds(bounds: readonly Bounds[]): Bounds {
  return Object.freeze({
    x0: Math.min(...bounds.map(value => value.x0)),
    y0: Math.min(...bounds.map(value => value.y0)),
    x1: Math.max(...bounds.map(value => value.x1)),
    y1: Math.max(...bounds.map(value => value.y1)),
  });
}

function overflow(media: Bounds, content: Bounds): number {
  return Math.max(media.x0 - content.x0, media.y0 - content.y0, content.x1 - media.x1, content.y1 - media.y1, 0);
}

export function inspectPdfContentBounds(pdfBytes: Uint8Array): PdfContentInspection {
  if (pdfBytes.byteLength === 0) throw new TypeError("PDF_CONTENT_BOUNDS_INVALID:empty-pdf");
  const document = mupdf.Document.openDocument(pdfBytes, "application/pdf");
  try {
    const pageCount = document.countPages();
    if (pageCount < 1) throw new TypeError("PDF_CONTENT_BOUNDS_INVALID:empty-document");
    const pageTexts: string[] = [];
    const pages = Array.from({ length: pageCount }, (_, pageIndex): PdfContentPageInspection => {
      const page = document.loadPage(pageIndex);
      try {
        const media = finiteRect(page.getBounds(), `page-${pageIndex}:media`);
        const clipStack: (Rect | null | undefined)[] = [undefined];
        const structured = page.toStructuredText("preserve-images");
        try {
          const blocks: { readonly kind: BlockKind; readonly bounds: Bounds }[] = [];
          const append = (kind: BlockKind, rect: Rect): void => {
            blocks.push(Object.freeze({ kind, bounds: finiteRect(rect, `page-${pageIndex}:${kind}`) }));
          };
          structured.walk({
            beginTextBlock: rect => append("text", rect),
            onImageBlock: (rect, _transform, image) => {
              try {
                append("image", rect);
              } finally {
                image.destroy();
              }
            },
          });
          const displayList = page.toDisplayList();
          const activeClip = (): Rect | null | undefined => clipStack[clipStack.length - 1];
          const pushClip = (rect: Rect): void => {
            const active = activeClip();
            clipStack.push(active === null ? null : active === undefined ? rect : intersectRect(active, rect));
          };
          const appendPaint = (rect: Rect): void => {
            const active = activeClip();
            if (active === null) return;
            const clipped = active === undefined ? rect : intersectRect(active, rect);
            if (clipped !== null) append("vector", clipped);
          };
          try {
            const device = new mupdf.Device({
            fillPath: (path, _evenOdd, transform, colorspace) => {
              try {
                appendPaint(path.getBounds(null as never, transform));
              } finally {
                colorspace.destroy();
                path.destroy();
              }
            },
            strokePath: (path, stroke, transform, colorspace) => {
              try {
                appendPaint(path.getBounds(stroke, transform));
              } finally {
                colorspace.destroy();
                stroke.destroy();
                path.destroy();
              }
            },
            clipPath: (path, _evenOdd, transform) => {
              try {
                pushClip(path.getBounds(null as never, transform));
              } finally {
                path.destroy();
              }
            },
            clipStrokePath: (path, stroke, transform) => {
              try {
                pushClip(path.getBounds(stroke, transform));
              } finally {
                stroke.destroy();
                path.destroy();
              }
            },
            clipText: (text, transform) => {
              try {
                pushClip(text.getBounds(null as never, transform));
              } finally {
                text.destroy();
              }
            },
            clipStrokeText: (text, stroke, transform) => {
              try {
                pushClip(text.getBounds(stroke, transform));
              } finally {
                stroke.destroy();
                text.destroy();
              }
            },
            clipImageMask: (image, transform) => {
              try {
                pushClip(mupdf.Rect.transform([0, 0, 1, 1], transform));
              } finally {
                image.destroy();
              }
            },
            popClip: () => {
              if (clipStack.length > 1) clipStack.pop();
            },
            });
            try {
              displayList.run(device, mupdf.Matrix.identity);
            } finally {
              try {
                device.close();
              } finally {
                device.destroy();
              }
            }
          } finally {
            displayList.destroy();
          }
          if (blocks.length === 0) throw new TypeError(`PDF_CONTENT_BOUNDS_INVALID:page-${pageIndex}:empty-content`);
          const text = structured.asText();
          const textByteCount = new TextEncoder().encode(text).byteLength;
          if (textByteCount < 1) throw new TypeError(`PDF_CONTENT_BOUNDS_INVALID:page-${pageIndex}:empty-text`);
          pageTexts.push(text);
          const overflows = blocks.map(block => overflow(media, block.bounds));
          const maximumOverflow = Math.max(...overflows);
          const outOfBoundsCount = overflows.filter(value => value > PDF_CONTENT_BOUNDS_TOLERANCE_POINTS).length;
          const counts = Object.freeze({
            text: blocks.filter(block => block.kind === "text").length,
            image: blocks.filter(block => block.kind === "image").length,
            vector: blocks.filter(block => block.kind === "vector").length,
            total: blocks.length,
          });
          return Object.freeze({
            page_index: pageIndex,
            bounds: media,
            content_bounds: unionBounds(blocks.map(block => block.bounds)),
            block_counts: counts,
            text_byte_count: textByteCount,
            out_of_bounds_count: outOfBoundsCount,
            maximum_overflow: maximumOverflow,
            clipped: outOfBoundsCount !== 0,
          });
        } finally {
          structured.destroy();
        }
      } finally {
        page.destroy();
      }
    });
    const extractedText = pageTexts.join("\n");
    return Object.freeze({
      page_count: pageCount,
      pages: Object.freeze(pages),
      extracted_text: extractedText,
      extracted_text_byte_count: new TextEncoder().encode(extractedText).byteLength,
    });
  } finally {
    document.destroy();
  }
}
