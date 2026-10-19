/** Per-item real cost: supplied supplier order, else allocated stock cost, else item snapshot. */
export const itemCostSql = (alias: string) => `CASE
  WHEN EXISTS (SELECT 1 FROM supplier_orders supplied WHERE supplied.order_item_id = ${alias}.id
               AND supplied.state = 'supplied')
  THEN COALESCE((SELECT CAST(supplied.total_cost_minor AS INTEGER) FROM supplier_orders supplied
                 WHERE supplied.order_item_id = ${alias}.id AND supplied.state = 'supplied'
                 ORDER BY supplied.updated_at DESC, supplied.id DESC LIMIT 1),
                CAST(${alias}.unit_cost_minor AS INTEGER) * ${alias}.quantity)
  ELSE COALESCE((SELECT SUM(CAST(stock.unit_cost_minor AS INTEGER)) FROM stock_entries stock
                 WHERE stock.order_item_id = ${alias}.id AND stock.status IN ('reserved', 'delivered')
                  AND stock.unit_cost_minor IS NOT NULL),
                CAST(${alias}.unit_cost_minor AS INTEGER) * ${alias}.quantity)
  END`;
