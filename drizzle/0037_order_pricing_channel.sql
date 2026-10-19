-- The payment channel whose prices an order was quoted with; payment through another channel is refused.
ALTER TABLE shop_orders ADD COLUMN pricing_channel_id TEXT;
