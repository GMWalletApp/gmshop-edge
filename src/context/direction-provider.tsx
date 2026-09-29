import { useSelector } from "@tanstack/react-store";
import { createContext, useContext, useEffect } from "react";
import {
	type Direction,
	defaultDirection,
	preferencesStore,
} from "#/stores/preferences-store";

export type { Direction } from "#/stores/preferences-store";

type DirectionProviderState = {
	defaultDir: Direction;
	dir: Direction;
	setDir: (dir: Direction) => void;
	resetDir: () => void;
};

const DirectionContext = createContext<DirectionProviderState | null>(null);

type DirectionProviderProps = {
	children: React.ReactNode;
};

export function DirectionProvider({ children }: DirectionProviderProps) {
	const dir = useSelector(preferencesStore, (state) => state.direction);

	useEffect(() => {
		window.document.documentElement.dir = dir;
	}, [dir]);

	return (
		<DirectionContext
			value={{
				defaultDir: defaultDirection,
				dir,
				setDir: preferencesStore.actions.setDirection,
				resetDir: preferencesStore.actions.resetDirection,
			}}
		>
			{children}
		</DirectionContext>
	);
}

export function useDirection() {
	const context = useContext(DirectionContext);

	if (!context) {
		throw new Error("useDirection must be used within a DirectionProvider");
	}

	return context;
}
