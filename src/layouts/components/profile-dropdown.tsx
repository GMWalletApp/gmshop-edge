import { KeyRound, Settings } from "lucide-react";
import { useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "#/components/ui/avatar";
import { Button } from "#/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import useDialogState from "#/hooks/use-dialog-state";
import { m } from "#/paraglide/messages";
import { useAuthUser } from "#/stores/auth-store";
import { ChangePasswordDialog } from "./change-password-dialog";
import { ConfigDrawer } from "./config-drawer";
import { SignOutDialog } from "./sign-out-dialog";

export function ProfileDropdown() {
	const [open, setOpen] = useDialogState();
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [passwordOpen, setPasswordOpen] = useState(false);
	const user = useAuthUser();
	const name = user?.name || user?.email || m.common_owner();
	const email = user?.email || "";
	const avatar = user?.image || "";
	const fallback = getUserFallback(name, email);

	return (
		<>
			<DropdownMenu modal={false}>
				<DropdownMenuTrigger asChild>
					<Button variant="ghost" className="relative h-8 w-8 rounded-full">
						<Avatar className="h-8 w-8">
							<AvatarImage src={avatar} alt={name} />
							<AvatarFallback>{fallback}</AvatarFallback>
						</Avatar>
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent className="w-56" align="end" forceMount>
					<DropdownMenuLabel className="font-normal">
						<div className="flex flex-col gap-1.5">
							<p className="text-sm leading-none font-medium">{name}</p>
							<p className="text-xs leading-none text-muted-foreground">
								{email}
							</p>
						</div>
					</DropdownMenuLabel>
					<DropdownMenuSeparator />
					<DropdownMenuItem
						onSelect={(event) => {
							event.preventDefault();
							setSettingsOpen(true);
						}}
					>
						<Settings />
						{m.layout_profile_settings()}
					</DropdownMenuItem>
					<DropdownMenuItem
						onSelect={(event) => {
							event.preventDefault();
							setPasswordOpen(true);
						}}
					>
						<KeyRound />
						{m.account_change_password_title()}
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem variant="destructive" onClick={() => setOpen(true)}>
						{m.layout_signOut_title()}
						<DropdownMenuShortcut className="text-current">
							⇧⌘Q
						</DropdownMenuShortcut>
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>

			<ConfigDrawer open={settingsOpen} onOpenChange={setSettingsOpen} />
			<ChangePasswordDialog
				open={passwordOpen}
				onOpenChange={setPasswordOpen}
			/>
			<SignOutDialog open={!!open} onOpenChange={setOpen} />
		</>
	);
}

function getUserFallback(name: string, email: string) {
	const source = name || email || "Root";
	return source
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((part) => part[0]?.toUpperCase())
		.join("");
}
