import { useSelector } from "@tanstack/react-store";
import { createContext, useContext } from "react";
import {
	type Collapsible,
	defaultLayoutCollapsible,
	defaultLayoutVariant,
	type LayoutVariant,
	preferencesStore,
} from "#/stores/preferences-store";

export type { Collapsible } from "#/stores/preferences-store";

type LayoutContextType = {
	resetLayout: () => void;

	defaultCollapsible: Collapsible;
	collapsible: Collapsible;
	setCollapsible: (collapsible: Collapsible) => void;

	defaultVariant: LayoutVariant;
	variant: LayoutVariant;
	setVariant: (variant: LayoutVariant) => void;
};

const LayoutContext = createContext<LayoutContextType | null>(null);

type LayoutProviderProps = {
	children: React.ReactNode;
};

export function LayoutProvider({ children }: LayoutProviderProps) {
	const collapsible = useSelector(
		preferencesStore,
		(state) => state.collapsible,
	);
	const variant = useSelector(preferencesStore, (state) => state.variant);

	const contextValue: LayoutContextType = {
		resetLayout: preferencesStore.actions.resetLayout,
		defaultCollapsible: defaultLayoutCollapsible,
		collapsible,
		setCollapsible: preferencesStore.actions.setCollapsible,
		defaultVariant: defaultLayoutVariant,
		variant,
		setVariant: preferencesStore.actions.setVariant,
	};

	return <LayoutContext value={contextValue}>{children}</LayoutContext>;
}

// Define the hook for the provider
export function useLayout() {
	const context = useContext(LayoutContext);
	if (!context) {
		throw new Error("useLayout must be used within a LayoutProvider");
	}
	return context;
}
