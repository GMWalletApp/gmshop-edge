import { useNavigate } from "@tanstack/react-router";
import { authClient } from "#/features/auth/auth-client";
import { m } from "#/paraglide/messages";
import { authStore } from "#/stores/auth-store";
import { ConfirmDialog } from "./confirm-dialog";

interface SignOutDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function SignOutDialog({ open, onOpenChange }: SignOutDialogProps) {
	const navigate = useNavigate();

	const handleSignOut = async () => {
		await authClient.signOut();
		authStore.actions.clearUser();
		onOpenChange(false);
		await navigate({
			to: "/sign-in",
			search: { redirect: undefined },
			replace: true,
		});
	};

	return (
		<ConfirmDialog
			open={open}
			onOpenChange={onOpenChange}
			title={m.layout_signOut_title()}
			desc={m.layout_signOut_description()}
			confirmText={m.layout_signOut_title()}
			cancelBtnText={m.common_cancel()}
			destructive
			handleConfirm={handleSignOut}
			className="sm:max-w-sm"
		/>
	);
}
