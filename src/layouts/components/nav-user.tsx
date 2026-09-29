import { ChevronsUpDown, KeyRound, LogOut, Settings } from "lucide-react";
import { useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "#/components/ui/avatar";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import {
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	useSidebar,
} from "#/components/ui/sidebar";
import { useDirection } from "#/context/direction-provider";
import useDialogState from "#/hooks/use-dialog-state";
import { m } from "#/paraglide/messages";
import { type AuthUser, useAuthUser } from "#/stores/auth-store";
import { ChangePasswordDialog } from "./change-password-dialog";
import { ConfigDrawer } from "./config-drawer";
import { SignOutDialog } from "./sign-out-dialog";

export function NavUser({ user: providedUser }: { user?: AuthUser }) {
	const { dir } = useDirection();
	const { isMobile } = useSidebar();
	const [open, setOpen] = useDialogState();
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [passwordOpen, setPasswordOpen] = useState(false);
	const storedUser = useAuthUser();
	const user = providedUser ?? storedUser;
	const name = user?.name || user?.email || "Root";
	const email = user?.email || "";
	const avatar = user?.image || "";
	const fallback = getUserFallback(name, email);

	return (
		<>
			<SidebarMenu>
				<SidebarMenuItem>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<SidebarMenuButton
								size="lg"
								className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
							>
								<Avatar className="h-8 w-8 rounded-lg">
									<AvatarImage src={avatar} alt={name} />
									<AvatarFallback className="rounded-lg">
										{fallback}
									</AvatarFallback>
								</Avatar>
								<div className="grid flex-1 text-start text-sm leading-tight">
									<span className="truncate font-semibold">{name}</span>
									<span className="truncate text-xs">{email}</span>
								</div>
								<ChevronsUpDown className="ms-auto size-4" />
							</SidebarMenuButton>
						</DropdownMenuTrigger>
						<DropdownMenuContent
							className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
							side={isMobile ? "bottom" : dir === "rtl" ? "left" : "right"}
							align="end"
							sideOffset={4}
						>
							<DropdownMenuLabel className="p-0 font-normal">
								<div className="flex items-center gap-2 px-1 py-1.5 text-start text-sm">
									<Avatar className="h-8 w-8 rounded-lg">
										<AvatarImage src={avatar} alt={name} />
										<AvatarFallback className="rounded-lg">
											{fallback}
										</AvatarFallback>
									</Avatar>
									<div className="grid flex-1 text-start text-sm leading-tight">
										<span className="truncate font-semibold">{name}</span>
										<span className="truncate text-xs">{email}</span>
									</div>
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
							<DropdownMenuItem
								variant="destructive"
								onClick={() => setOpen(true)}
							>
								<LogOut />
								{m.layout_signOut_title()}
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</SidebarMenuItem>
			</SidebarMenu>

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
