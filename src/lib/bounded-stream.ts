export class BodyLimitExceededError extends Error {
	constructor(readonly maximumBytes: number) {
		super(`Body exceeds ${maximumBytes} bytes`);
		this.name = "BodyLimitExceededError";
	}
}

export async function readBoundedRequestBytes(
	request: Request,
	maximumBytes: number,
) {
	assertDeclaredLength(request.headers, maximumBytes);
	return readBoundedStream(request.body, maximumBytes);
}

/**
 * Parse a JSON request body that must stay under `maximumBytes`, whether or not
 * the client declared a Content-Length. An empty body parses as `{}`.
 */
export async function readBoundedRequestJson(
	request: Request,
	maximumBytes: number,
): Promise<unknown> {
	const text = await readBoundedRequestText(request, maximumBytes);
	return text ? JSON.parse(text) : {};
}

export async function readBoundedRequestText(
	request: Request,
	maximumBytes: number,
) {
	return new TextDecoder().decode(
		await readBoundedRequestBytes(request, maximumBytes),
	);
}

export async function readBoundedResponseBytes(
	response: Response,
	maximumBytes: number,
) {
	assertDeclaredLength(response.headers, maximumBytes);
	return readBoundedStream(response.body, maximumBytes);
}

export async function readBoundedStream(
	stream: ReadableStream<Uint8Array> | null,
	maximumBytes: number,
) {
	if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0)
		throw new TypeError("maximumBytes must be a non-negative safe integer");
	if (!stream) return new Uint8Array();
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maximumBytes) {
				await reader.cancel("body_too_large");
				throw new BodyLimitExceededError(maximumBytes);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const result = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

function assertDeclaredLength(headers: Headers, maximumBytes: number) {
	const raw = headers.get("content-length");
	if (raw === null) return;
	const length = Number(raw);
	if (!Number.isSafeInteger(length) || length < 0 || length > maximumBytes)
		throw new BodyLimitExceededError(maximumBytes);
}
