/**
 * Pictures in the wallet (2026-11-12): the wallet's own list of the picture
 * types it shows, and the redraw a picked picture goes through before it is
 * sent. Since 2026-11-21 also the cut of the public selfie: the middle of
 * the picture as a small square.
 */

/** The three picture types the wallet shows: the three the masterpod takes (masterpod spec 3). The wallet keeps this list itself and does not go by the type a server names. */
export const IMAGE_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * Decrypted bytes as an object URL, for an <img> and the link that opens the
 * picture in a new tab; null when the type the masterpod named is not one of
 * the three. A Blob opens as what its type says, and the page it opens as
 * has the wallet's own address: bytes named text/html would run there as a
 * page of the wallet. So the type a server names is never passed on
 * unchecked.
 */
export function imageObjectUrl(bytes: Uint8Array, contentType: string): string | null {
  if (!IMAGE_CONTENT_TYPES.includes(contentType)) return null;
  return URL.createObjectURL(new Blob([bytes as BlobPart], { type: contentType }));
}

/**
 * A picked file redrawn: decoded by the browser with the orientation from
 * the file, drawn to a canvas on white, the longer side scaled down to
 * `limit` pixels when it is longer (the aspect kept), and encoded as a fresh
 * JPEG at the factor `jpeg`. What comes out is pixels only: the file's own
 * bytes, and whatever else it carried (the place a photo was taken, for
 * one), are not sent. Null when the browser cannot decode the file or the
 * canvas cannot encode it: such a file is refused, never sent as it is.
 */
export async function redrawImage(file: Blob, limit: number, jpeg: number): Promise<Blob | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return null;
  }
  const canvas = document.createElement('canvas');
  try {
    const longer = Math.max(bitmap.width, bitmap.height);
    const scale = longer > limit ? limit / longer : 1;
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', jpeg));
  } finally {
    bitmap.close();
    // Hands the canvas's memory back at once: a phone lets a page hold only so much of it.
    canvas.width = 0;
    canvas.height = 0;
  }
}

/**
 * The middle of a picture as a square JPEG (2026-11-21), for the public
 * selfie: the largest square that fits in `source`, taken from its middle,
 * drawn on white to a canvas of `side` by `side` pixels, or of the
 * square's own size when that is smaller (never scaled up), and encoded at
 * the factor `jpeg`. `width` and `height` are the source's own size in
 * pixels. Every place that shows a selfie shows that middle square, so the
 * strips beside it are not sent. Null when the canvas cannot encode it.
 *
 * The square is made smaller in halvings, with one last step of less than a
 * halving: a phone's own photo is about ten times as wide as the square,
 * and drawn that much smaller in a single step its fine lines break up
 * into speckle, in Safari and in Chrome alike (measured 2026-11-21). A
 * halving takes the mean of four pixels, which every browser does the same
 * way.
 */
export async function squareJpeg(source: CanvasImageSource, width: number, height: number, side: number, jpeg: number): Promise<Blob | null> {
  let span = Math.min(width, height);
  const size = Math.max(1, Math.min(side, span));
  let from = source;
  let left = (width - span) / 2;
  let top = (height - span) / 2;
  const canvases: HTMLCanvasElement[] = [];
  try {
    for (;;) {
      const last = span < size * 2;
      const edge = last ? size : Math.floor(span / 2);
      const canvas = document.createElement('canvas');
      canvases.push(canvas);
      canvas.width = canvas.height = edge;
      const context = canvas.getContext('2d');
      if (!context) return null;
      if (last) {
        context.fillStyle = '#fff';
        context.fillRect(0, 0, edge, edge);
      }
      context.drawImage(from, left, top, span, span, 0, 0, edge, edge);
      if (last) return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', jpeg));
      from = canvas;
      left = 0;
      top = 0;
      span = edge;
    }
  } finally {
    // Hands the canvases' memory back at once, as redrawImage does.
    for (const canvas of canvases) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

/**
 * A picked file as the square of squareJpeg (2026-11-21): decoded as
 * redrawImage decodes it, with the orientation from the file. Null when
 * the browser cannot decode the file or the canvas cannot encode it: such
 * a file is refused, never sent as it is.
 */
export async function redrawSquare(file: Blob, side: number, jpeg: number): Promise<Blob | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return null;
  }
  try {
    return await squareJpeg(bitmap, bitmap.width, bitmap.height, side, jpeg);
  } finally {
    bitmap.close();
  }
}
