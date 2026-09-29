import { m } from "#/paraglide/messages";

export function catalogOperationErrorMessage(error: unknown) {
	if (!error || typeof error !== "object" || !("code" in error))
		return m.catalog_operation_failed();
	switch (error.code) {
		case "product_in_use":
			return m.catalog_error_record_in_use();
		case "product_not_found":
		case "inventory_not_found":
			return m.catalog_error_not_found();
		case "inventory_locked":
			return m.inventory_error_locked();
		case "inventory_batch_too_large":
			return m.inventory_error_batch_too_large();
		case "product_media_invalid":
			return m.catalog_cover_image_invalid();
		case "supplier_sellable_item_managed_externally":
			return m.catalog_error_supplier_managed();
		case "supplier_product_cannot_be_duplicated":
			return m.catalog_error_supplier_duplicate();
		case "reauthentication_failed":
			return m.auth_error_invalid_credentials();
		case "reauthentication_rate_limited":
			return m.auth_error_reauthentication_rate_limited();
		case "product_has_order_history":
			return m.catalog_error_order_history();
		default:
			return m.catalog_operation_failed();
	}
}
