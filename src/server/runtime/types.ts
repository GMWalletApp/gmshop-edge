export type RuntimeKind = "bun" | "cloudflare";

export type RuntimeDatabaseMeta = {
	changes: number;
	[key: string]: unknown;
};

export type RuntimeDatabaseResult<T = unknown> = {
	success: true;
	results: T[];
	meta: RuntimeDatabaseMeta;
};

export type RuntimeDatabaseExecResult = {
	count: number;
	duration: number;
};

export interface RuntimePreparedStatement {
	bind(...values: unknown[]): RuntimePreparedStatement;
	first<T = unknown>(columnName: string): Promise<T | null>;
	first<T = Record<string, unknown>>(): Promise<T | null>;
	run<T = Record<string, unknown>>(): Promise<RuntimeDatabaseResult<T>>;
	all<T = Record<string, unknown>>(): Promise<RuntimeDatabaseResult<T>>;
	raw<T = unknown[]>(options: {
		columnNames: true;
	}): Promise<[string[], ...T[]]>;
	raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
}

export interface RuntimeDatabase {
	prepare(query: string): RuntimePreparedStatement;
	batch<T = unknown>(
		statements: RuntimePreparedStatement[],
	): Promise<RuntimeDatabaseResult<T>[]>;
	exec(query: string): Promise<RuntimeDatabaseExecResult>;
}

export type RuntimeCachePutOptions = {
	expiration?: number;
	expirationTtl?: number;
	metadata?: unknown;
};

export interface RuntimeCache {
	get(key: string): Promise<string | null>;
	put(
		key: string,
		value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
		options?: RuntimeCachePutOptions,
	): Promise<void>;
	delete(key: string): Promise<void>;
}

export type RuntimeObjectHttpMetadata = {
	contentType?: string;
	contentLanguage?: string;
	contentDisposition?: string;
	contentEncoding?: string;
	cacheControl?: string;
	cacheExpiry?: Date;
};

export type RuntimeObjectPutOptions = {
	httpMetadata?: RuntimeObjectHttpMetadata;
	customMetadata?: Record<string, string>;
	md5?: ArrayBuffer | string;
	sha1?: ArrayBuffer | string;
	sha256?: ArrayBuffer | string;
	sha384?: ArrayBuffer | string;
	sha512?: ArrayBuffer | string;
};

export interface RuntimeObjectMetadata {
	readonly key: string;
	readonly version: string;
	readonly size: number;
	readonly etag: string;
	readonly httpEtag: string;
	readonly uploaded: Date;
	readonly httpMetadata?: RuntimeObjectHttpMetadata;
	readonly customMetadata?: Record<string, string>;
	writeHttpMetadata(headers: Headers): void;
}

export interface RuntimeObjectBody extends RuntimeObjectMetadata {
	readonly body: ReadableStream;
	readonly bodyUsed: boolean;
	arrayBuffer(): Promise<ArrayBuffer>;
	bytes(): Promise<Uint8Array>;
	text(): Promise<string>;
	json<T>(): Promise<T>;
	blob(): Promise<Blob>;
}

export interface RuntimeObjectStorage {
	head(key: string): Promise<RuntimeObjectMetadata | null>;
	get(
		key: string,
		options?: { onlyIf?: Headers },
	): Promise<RuntimeObjectBody | RuntimeObjectMetadata | null>;
	put(
		key: string,
		value:
			| ReadableStream
			| ArrayBuffer
			| ArrayBufferView
			| string
			| null
			| Blob,
		options?: RuntimeObjectPutOptions,
	): Promise<RuntimeObjectMetadata | null>;
	delete(keys: string | string[]): Promise<void>;
}

export type RuntimeQueueSendOptions = {
	contentType?: "text" | "bytes" | "json" | "v8";
	delaySeconds?: number;
};

export type RuntimeQueueMessage<T> = RuntimeQueueSendOptions & { body: T };

export interface RuntimeQueue<T = unknown> {
	send(message: T, options?: RuntimeQueueSendOptions): Promise<unknown>;
	sendBatch(
		messages: Iterable<RuntimeQueueMessage<T>>,
		options?: Pick<RuntimeQueueSendOptions, "delaySeconds">,
	): Promise<unknown>;
}

export type RuntimeEnv = {
	AGENT_ACCESS_SIGNING_KEY?: string;
	AGENT_SHOP_PROGRAM_TOKEN?: string;
	AGENT_PROGRAM_PROFIT_TOKEN?: string;
	runtime: RuntimeKind;
	DB?: RuntimeDatabase;
	FILES?: RuntimeObjectStorage;
	CACHE?: RuntimeCache;
	COMMERCE_QUEUE?: RuntimeQueue;
	EMAIL?: SendEmail;
	RESTOCK_API_TOKEN?: string;
	INVOICE_LOOKUP_TOKEN?: string;
	GMSHOP_EDGEONE_ORIGIN_VERIFY?: string;
	TURNSTILE_SITE_KEY?: string;
	TURNSTILE_SECRET_KEY?: string;
	waitUntil?: (promise: Promise<unknown>) => void;
};
