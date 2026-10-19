import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";
import { guideProducts } from "#/features/home/buying-guide-rules";
import { StorefrontProductPage } from "#/features/storefront/pages/product";

export const Route = createFileRoute("/(public)/products/$productId")({
	validateSearch: z.object({
		item: z.uuid().optional().catch(undefined),
		src: z.enum(["order", "redeem"]).optional().catch(undefined),
	}),
	beforeLoad: ({ params }) => {
		if (params.productId === "aa277f98-79b4-58cb-8b7b-1424fe930ab9") {
			throw redirect({
				to: "/products/$productId",
				params: { productId: guideProducts.twentyrenew.productId },
				search: { item: guideProducts.twentyrenew.itemId },
				hash: "purchase-options",
				replace: true,
			});
		}
	},
	component: ProductRoute,
});

function ProductRoute() {
	const { productId } = Route.useParams();
	const { item, src } = Route.useSearch();
	return (
		<StorefrontProductPage
			key={`${productId}:${item ?? ""}`}
			productId={productId}
			preferredItemId={item}
			landingSource={src}
		/>
	);
}
