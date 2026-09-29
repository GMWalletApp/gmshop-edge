export type DomainErrorOptions = {
	/**
	 * Whether another attempt can succeed without an operator changing state.
	 * Background consumers retry retryable errors and acknowledge the rest.
	 * Defaults to `true` for 5xx (outages) and `false` for 4xx (rejections).
	 */
	retryable?: boolean;
};

export class DomainError extends Error {
	readonly retryable: boolean;

	constructor(
		readonly code: string,
		readonly status: number,
		message: string,
		options: DomainErrorOptions = {},
	) {
		super(message);
		this.name = "DomainError";
		this.retryable = options.retryable ?? status >= 500;
	}
}
