import { useEffect, useState } from 'react';
import { Plus, ShieldAlert, Trash2, Users } from 'lucide-react';
import { toast } from 'sonner';
import {
	CATEGORIES,
	CATEGORY_LABELS,
	SENSITIVE_CATEGORIES,
	deleteJson,
	getJson,
	postJson,
	type GrantItem,
	type User,
	type UserItem,
} from '@/api';
import { CategoryBadge } from '@/components/CategoryBadge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

function parseCategories(json: string): string[] {
	try {
		const parsed = JSON.parse(json);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

export function AdminPage({ currentUser }: { currentUser: User }): JSX.Element {
	const [users, setUsers] = useState<UserItem[]>([]);
	const [grants, setGrants] = useState<GrantItem[]>([]);

	// New user form
	const [newUsername, setNewUsername] = useState('');
	const [newPassword, setNewPassword] = useState('');
	const [newRole, setNewRole] = useState<'user' | 'admin'>('user');

	// New grant form
	const [grantUserId, setGrantUserId] = useState<number | ''>('');
	const [grantPattern, setGrantPattern] = useState('');
	const [grantCategories, setGrantCategories] = useState<string[]>(['login_code', 'registration']);
	const [grantSensitive, setGrantSensitive] = useState(false);

	const refresh = (): void => {
		Promise.all([
			getJson<{ users: UserItem[] }>('/api/admin/users'),
			getJson<{ grants: GrantItem[] }>('/api/admin/grants'),
		])
			.then(([usersPayload, grantsPayload]) => {
				setUsers(usersPayload.users);
				setGrants(grantsPayload.grants);
			})
			.catch((error: unknown) => toast.error(error instanceof Error ? error.message : 'Unable to load admin data'));
	};

	useEffect(refresh, []);

	const createUser = (): void => {
		if (!newUsername || newPassword.length < 8) {
			toast.error('Username and a password of at least 8 characters are required');
			return;
		}
		postJson('/api/admin/users', { username: newUsername, password: newPassword, role: newRole })
			.then(() => {
				toast.success(`User ${newUsername} created`);
				setNewUsername('');
				setNewPassword('');
				setNewRole('user');
				refresh();
			})
			.catch((error: unknown) => toast.error(error instanceof Error ? error.message : 'Unable to create user'));
	};

	const deleteUser = (target: UserItem): void => {
		if (!window.confirm(`Delete user ${target.username}? Their grants and API keys go with them.`)) return;
		deleteJson(`/api/admin/users/${target.id}`)
			.then(() => {
				toast.success(`User ${target.username} deleted`);
				refresh();
			})
			.catch((error: unknown) => toast.error(error instanceof Error ? error.message : 'Unable to delete user'));
	};

	const toggleCategory = (category: string): void => {
		setGrantCategories((current) =>
			current.includes(category) ? current.filter((c) => c !== category) : [...current, category],
		);
	};

	const createGrant = (): void => {
		if (!grantUserId || !grantPattern || grantCategories.length === 0) {
			toast.error('Pick a user, an address pattern, and at least one category');
			return;
		}
		postJson('/api/admin/grants', {
			userId: grantUserId,
			addressPattern: grantPattern.trim(),
			allowedCategories: grantCategories,
			allowSensitive: grantSensitive,
		})
			.then(() => {
				toast.success('Grant created');
				setGrantPattern('');
				setGrantSensitive(false);
				refresh();
			})
			.catch((error: unknown) => toast.error(error instanceof Error ? error.message : 'Unable to create grant'));
	};

	const deleteGrant = (id: number): void => {
		deleteJson(`/api/admin/grants/${id}`)
			.then(() => {
				toast.success('Grant removed');
				refresh();
			})
			.catch((error: unknown) => toast.error(error instanceof Error ? error.message : 'Unable to remove grant'));
	};

	const hasSensitiveSelected = grantCategories.some((c) => SENSITIVE_CATEGORIES.includes(c));
	const nonAdminUsers = users.filter((u) => u.role !== 'admin');

	return (
		<div className="grid gap-6 lg:grid-cols-[1fr_1.3fr] [&>*]:min-w-0">
			<Card className="p-6">
				<CardHeader className="p-0 pb-4">
					<CardTitle className="flex items-center gap-2">
						<Users className="h-4 w-4 text-primary" />
						Users
					</CardTitle>
					<div className="text-xs text-muted-foreground">Admins see everything. Users only see what you grant below.</div>
				</CardHeader>

				<div className="mb-4 space-y-3 rounded-lg border border-border/80 bg-[#111111] p-4">
					<div className="grid gap-3 sm:grid-cols-2">
						<div className="space-y-1.5">
							<Label htmlFor="new-username">Username</Label>
							<Input id="new-username" value={newUsername} onChange={(event) => setNewUsername(event.target.value)} />
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="new-password">Password</Label>
							<Input
								id="new-password"
								type="password"
								autoComplete="new-password"
								value={newPassword}
								onChange={(event) => setNewPassword(event.target.value)}
							/>
						</div>
					</div>
					<div className="flex items-center justify-between gap-3">
						<div className="flex gap-2">
							{(['user', 'admin'] as const).map((role) => (
								<button
									key={role}
									type="button"
									onClick={() => setNewRole(role)}
									className={cn(
										'rounded-md border px-3 py-1.5 text-xs transition-colors',
										newRole === role
											? 'border-primary/50 bg-primary/10 text-primary'
											: 'border-border text-muted-foreground hover:bg-accent',
									)}
								>
									{role}
								</button>
							))}
						</div>
						<Button onClick={createUser} className="gap-2">
							<Plus className="h-4 w-4" />
							Create user
						</Button>
					</div>
				</div>

				<div className="overflow-hidden rounded-xl border border-border/80">
					<table className="w-full border-collapse text-sm">
						<thead className="bg-[#111111] text-left text-xs uppercase tracking-[0.08em] text-muted-foreground">
							<tr>
								<th className="px-3 py-3">User</th>
								<th className="px-3 py-3">Role</th>
								<th className="px-3 py-3" />
							</tr>
						</thead>
						<tbody className="divide-y divide-border/80">
							{users.map((item) => (
								<tr key={item.id}>
									<td className="px-3 py-3 font-medium text-slate-100">
										{item.username}
										{item.id === currentUser.id ? <span className="ml-2 text-xs text-muted-foreground">(you)</span> : null}
									</td>
									<td className="px-3 py-3">
										<span
											className={cn(
												'rounded-md border px-2 py-0.5 font-mono text-[11px]',
												item.role === 'admin'
													? 'border-primary/40 bg-primary/10 text-primary'
													: 'border-border bg-secondary text-muted-foreground',
											)}
										>
											{item.role}
										</span>
									</td>
									<td className="px-3 py-3 text-right">
										{item.id !== currentUser.id ? (
											<Button
												variant="ghost"
												size="icon"
												className="h-8 w-8 text-muted-foreground hover:text-red-300"
												onClick={() => deleteUser(item)}
											>
												<Trash2 className="h-4 w-4" />
											</Button>
										) : null}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</Card>

			<Card className="p-6">
				<CardHeader className="p-0 pb-4">
					<CardTitle>Access Grants</CardTitle>
					<div className="text-xs text-muted-foreground">
						A grant is one user, one address pattern, and the categories they may read there.
					</div>
				</CardHeader>

				<div className="mb-4 space-y-3 rounded-lg border border-border/80 bg-[#111111] p-4">
					<div className="grid gap-3 sm:grid-cols-2">
						<div className="space-y-1.5">
							<Label htmlFor="grant-user">User</Label>
							<select
								id="grant-user"
								className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [&>option]:bg-[#111111]"
								value={grantUserId}
								onChange={(event) => setGrantUserId(event.target.value ? Number(event.target.value) : '')}
							>
								<option value="">Select a user</option>
								{nonAdminUsers.map((item) => (
									<option key={item.id} value={item.id}>
										{item.username}
									</option>
								))}
							</select>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="grant-pattern">Address pattern</Label>
							<Input
								id="grant-pattern"
								placeholder="netflix@mail.example.com or *@mail.example.com"
								className="font-mono text-xs"
								value={grantPattern}
								onChange={(event) => setGrantPattern(event.target.value)}
							/>
						</div>
					</div>

					<div className="space-y-1.5">
						<Label>Visible categories</Label>
						<div className="flex flex-wrap gap-2">
							{CATEGORIES.map((category) => {
								const selected = grantCategories.includes(category);
								const sensitive = SENSITIVE_CATEGORIES.includes(category);
								return (
									<button
										key={category}
										type="button"
										onClick={() => toggleCategory(category)}
										className={cn(
											'rounded-md border px-2.5 py-1 font-mono text-[11px] transition-colors',
											selected
												? sensitive
													? 'border-red-500/50 bg-red-500/10 text-red-300'
													: 'border-primary/50 bg-primary/10 text-primary'
												: 'border-border text-muted-foreground hover:bg-accent',
										)}
									>
										{CATEGORY_LABELS[category]}
									</button>
								);
							})}
						</div>
					</div>

					{hasSensitiveSelected ? (
						<label className="flex cursor-pointer items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-xs text-red-200">
							<input
								type="checkbox"
								className="mt-0.5 h-4 w-4 accent-red-400"
								checked={grantSensitive}
								onChange={(event) => setGrantSensitive(event.target.checked)}
							/>
							<span>
								<ShieldAlert className="mr-1 inline h-3.5 w-3.5" />
								Password reset and account security mail can take over the account behind an address. Without this
								confirmation the server drops those categories from the grant.
							</span>
						</label>
					) : null}

					<div className="flex justify-end">
						<Button onClick={createGrant} className="gap-2">
							<Plus className="h-4 w-4" />
							Create grant
						</Button>
					</div>
				</div>

				<div className="overflow-hidden rounded-xl border border-border/80">
					<table className="w-full border-collapse text-sm">
						<thead className="bg-[#111111] text-left text-xs uppercase tracking-[0.08em] text-muted-foreground">
							<tr>
								<th className="px-3 py-3">User</th>
								<th className="px-3 py-3">Pattern</th>
								<th className="px-3 py-3">Categories</th>
								<th className="px-3 py-3" />
							</tr>
						</thead>
						<tbody className="divide-y divide-border/80">
							{grants.length === 0 ? (
								<tr>
									<td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">
										No grants yet. Users see nothing until you create one.
									</td>
								</tr>
							) : (
								grants.map((grant) => (
									<tr key={grant.id}>
										<td className="px-3 py-3 font-medium text-slate-100">{grant.username}</td>
										<td className="max-w-[180px] truncate px-3 py-3 font-mono text-xs text-slate-300">{grant.addressPattern}</td>
										<td className="px-3 py-3">
											<div className="flex flex-wrap gap-1">
												{parseCategories(grant.allowedCategories).map((category) => (
													<CategoryBadge key={category} category={category} />
												))}
												{grant.allowSensitive ? (
													<span className="rounded-md border border-red-500/40 px-2 py-0.5 font-mono text-[11px] text-red-300">
														sensitive allowed
													</span>
												) : null}
											</div>
										</td>
										<td className="px-3 py-3 text-right">
											<Button
												variant="ghost"
												size="icon"
												className="h-8 w-8 text-muted-foreground hover:text-red-300"
												onClick={() => deleteGrant(grant.id)}
											>
												<Trash2 className="h-4 w-4" />
											</Button>
										</td>
									</tr>
								))
							)}
						</tbody>
					</table>
				</div>
			</Card>
		</div>
	);
}
