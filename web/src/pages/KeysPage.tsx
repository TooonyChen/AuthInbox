import { useEffect, useState } from 'react';
import { Copy, KeyRound, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { deleteJson, getJson, postJson, type ApiKeyItem } from '@/api';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

function formatDate(value: string | null): string {
	if (!value) return '-';
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function KeysPage(): JSX.Element {
	const [keys, setKeys] = useState<ApiKeyItem[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [newKeyName, setNewKeyName] = useState('');
	const [freshKey, setFreshKey] = useState<string | null>(null);
	const [isCreating, setIsCreating] = useState(false);

	const mcpUrl = `${window.location.origin}/mcp`;

	const refresh = (): void => {
		setIsLoading(true);
		getJson<{ keys: ApiKeyItem[] }>('/api/keys')
			.then((payload) => setKeys(payload.keys))
			.catch((error: unknown) => toast.error(error instanceof Error ? error.message : 'Unable to load keys'))
			.finally(() => setIsLoading(false));
	};

	useEffect(refresh, []);

	const createKey = (): void => {
		setIsCreating(true);
		postJson<{ id: number; key: string }>('/api/keys', { name: newKeyName.trim() || 'default' })
			.then((payload) => {
				setFreshKey(payload.key);
				setNewKeyName('');
				refresh();
			})
			.catch((error: unknown) => toast.error(error instanceof Error ? error.message : 'Unable to create key'))
			.finally(() => setIsCreating(false));
	};

	const revokeKey = (id: number): void => {
		deleteJson(`/api/keys/${id}`)
			.then(() => {
				toast.success('Key revoked');
				refresh();
			})
			.catch((error: unknown) => toast.error(error instanceof Error ? error.message : 'Unable to revoke key'));
	};

	const copy = (value: string, label: string): void => {
		navigator.clipboard.writeText(value);
		toast.success(`${label} copied`);
	};

	return (
		<div className="grid gap-6 lg:grid-cols-[1fr_1fr] [&>*]:min-w-0">
			<Card className="p-6">
				<CardHeader className="p-0 pb-4">
					<CardTitle className="flex items-center gap-2">
						<KeyRound className="h-4 w-4 text-primary" />
						API Keys
					</CardTitle>
					<div className="text-xs text-muted-foreground">
						Keys let MCP clients read mail as you, with the same access you have here.
					</div>
				</CardHeader>

				<div className="mb-4 flex gap-2">
					<Input
						placeholder="Key name, e.g. claude-code"
						value={newKeyName}
						onChange={(event) => setNewKeyName(event.target.value)}
						onKeyDown={(event) => event.key === 'Enter' && createKey()}
					/>
					<Button onClick={createKey} disabled={isCreating} className="gap-2">
						<Plus className="h-4 w-4" />
						Create key
					</Button>
				</div>

				{freshKey ? (
					<div className="mb-4 rounded-lg border border-primary/40 bg-primary/10 p-3">
						<div className="mb-2 text-xs text-slate-200">
							Copy this key now. It won't be shown again.
						</div>
						<div className="flex items-center gap-2">
							<code className="flex-1 truncate rounded bg-[#0a0a0a] px-2 py-1.5 font-mono text-xs text-primary">{freshKey}</code>
							<Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => copy(freshKey, 'Key')}>
								<Copy className="h-3 w-3" />
								Copy
							</Button>
						</div>
					</div>
				) : null}

				<div className="overflow-hidden rounded-xl border border-border/80">
					<table className="w-full border-collapse text-sm">
						<thead className="bg-[#111111] text-left text-xs uppercase tracking-[0.08em] text-muted-foreground">
							<tr>
								<th className="px-3 py-3">Name</th>
								<th className="hidden px-3 py-3 sm:table-cell">Created</th>
								<th className="hidden px-3 py-3 sm:table-cell">Last used</th>
								<th className="px-3 py-3" />
							</tr>
						</thead>
						<tbody className="divide-y divide-border/80">
							{isLoading ? (
								<tr>
									<td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">Loading…</td>
								</tr>
							) : keys.length === 0 ? (
								<tr>
									<td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">
										No keys yet. Create one to connect an MCP client.
									</td>
								</tr>
							) : (
								keys.map((key) => (
									<tr key={key.id}>
										<td className="px-3 py-3 font-medium text-slate-100">{key.name}</td>
										<td className="hidden px-3 py-3 text-xs text-muted-foreground sm:table-cell">{formatDate(key.createdAt)}</td>
										<td className="hidden px-3 py-3 text-xs text-muted-foreground sm:table-cell">{formatDate(key.lastUsedAt)}</td>
										<td className="px-3 py-3 text-right">
											<Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-red-300" onClick={() => revokeKey(key.id)}>
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

			<Card className="p-6">
				<CardHeader className="p-0 pb-4">
					<CardTitle>Connect an MCP client</CardTitle>
					<div className="text-xs text-muted-foreground">
						The server exposes list_addresses, list_codes, get_latest_code, and wait_for_code.
					</div>
				</CardHeader>

				<div className="space-y-4 text-sm text-slate-300">
					<div>
						<div className="mb-1.5 text-xs uppercase tracking-[0.08em] text-muted-foreground">Server URL</div>
						<div className="flex items-center gap-2">
							<code className="flex-1 truncate rounded bg-[#0a0a0a] px-2 py-1.5 font-mono text-xs">{mcpUrl}</code>
							<Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => copy(mcpUrl, 'URL')}>
								<Copy className="h-3 w-3" />
								Copy
							</Button>
						</div>
					</div>

					<div>
						<div className="mb-1.5 text-xs uppercase tracking-[0.08em] text-muted-foreground">Claude Code</div>
						<pre className="overflow-auto rounded-lg border border-border/80 bg-[#0a0a0a] p-3 font-mono text-xs leading-6 text-slate-300">
{`claude mcp add --transport http authinbox \\
  ${mcpUrl} \\
  --header "Authorization: Bearer <your-key>"`}
						</pre>
					</div>

					<p className="text-xs text-muted-foreground">
						Authenticate with the Authorization header, value "Bearer" plus your key. Revoking a key here cuts that client off immediately.
					</p>
				</div>
			</Card>
		</div>
	);
}
