import { convertMinorAmount } from "#/features/exchange-rates/rates";
import { DomainError } from "#/lib/domain-error";

type ExchangeRateRow = {
	id: string;
	base_currency: string;
	quote_currency: string;
	rate: string;
	source: string;
	adjustment_bps: number;
	observed_at: number;
};

export type PaymentCurrencyQuote = {
	amountMinor: string;
	currency: string;
	currencyDecimals: number;
	rateId: string | null;
	rate: string;
	rateDirection: "parity" | "multiply" | "divide";
	rateSource: string;
	rateAdjustmentBps: number;
	rateObservedAt: number;
};

export async function quotePaymentCurrency(
	db: D1Database,
	input: {
		amountMinor: string;
		currency: string;
		currencyDecimals: number;
		paymentCurrency: string;
		now?: number;
	},
): Promise<PaymentCurrencyQuote> {
	const now = input.now ?? Date.now();
	const currency = input.currency.toUpperCase();
	const paymentCurrency = input.paymentCurrency.toUpperCase();
	if (currency === paymentCurrency)
		return {
			amountMinor: input.amountMinor,
			currency,
			currencyDecimals: input.currencyDecimals,
			rateId: null,
			rate: "1",
			rateDirection: "parity",
			rateSource: "parity",
			rateAdjustmentBps: 0,
			rateObservedAt: now,
		};
	const rate = await db
		.prepare(
			`SELECT id, base_currency, quote_currency, rate, source, adjustment_bps,
			 observed_at FROM exchange_rates
			 WHERE ((base_currency = ? AND quote_currency = ?) OR
			  (base_currency = ? AND quote_currency = ?))
			 AND enabled = 1 AND (expires_at IS NULL OR expires_at > ?)
			 ORDER BY CASE WHEN base_currency = ? THEN 0 ELSE 1 END,
			 sort_order, observed_at DESC, id LIMIT 1`,
		)
		.bind(currency, paymentCurrency, paymentCurrency, currency, now, currency)
		.first<ExchangeRateRow>();
	if (!rate)
		throw new DomainError(
			"exchange_rate_unavailable",
			409,
			"The selected payment currency is unavailable",
		);
	const direction = rate.base_currency === currency ? "multiply" : "divide";
	return {
		...convertMinorAmount({
			amountMinor: input.amountMinor,
			fromCurrency: currency,
			fromDecimals: input.currencyDecimals,
			toCurrency: paymentCurrency,
			rate: rate.rate,
			direction,
		}),
		rateId: rate.id,
		rate: rate.rate,
		rateDirection: direction,
		rateSource: rate.source,
		rateAdjustmentBps: rate.adjustment_bps,
		rateObservedAt: rate.observed_at,
	};
}
