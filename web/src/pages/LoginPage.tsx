import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { getJson, postJson, type User } from '@/api';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface LoginPageProps {
	onLogin: (user: User) => void;
}

export function LoginPage({ onLogin }: LoginPageProps): JSX.Element {
	const [setupNeeded, setSetupNeeded] = useState(false);
	const [username, setUsername] = useState('');
	const [password, setPassword] = useState('');
	const [isSubmitting, setIsSubmitting] = useState(false);

	useEffect(() => {
		getJson<{ needed: boolean }>('/api/auth/setup')
			.then((payload) => setSetupNeeded(payload.needed))
			.catch(() => setSetupNeeded(false));
	}, []);

	const submit = (): void => {
		if (!username || !password) {
			toast.error('Enter a username and password');
			return;
		}
		if (setupNeeded && password.length < 8) {
			toast.error('Password needs at least 8 characters');
			return;
		}
		setIsSubmitting(true);

		const flow = setupNeeded
			? postJson('/api/auth/setup', { username, password }).then(() =>
					postJson<{ user: User }>('/api/auth/login', { username, password }),
				)
			: postJson<{ user: User }>('/api/auth/login', { username, password });

		flow
			.then((payload) => {
				onLogin(payload.user);
			})
			.catch((error: unknown) => {
				toast.error(error instanceof Error ? error.message : 'Sign in failed');
			})
			.finally(() => setIsSubmitting(false));
	};

	return (
		<div className="flex min-h-screen items-center justify-center px-4">
			<div className="pointer-events-none fixed inset-0 bg-[radial-gradient(900px_400px_at_50%_-10%,rgba(95,224,192,0.1),transparent)]" />
			<Card className="relative w-full max-w-sm p-8">
				<div className="mb-6">
					<div className="mb-3 flex items-center gap-2 text-xs uppercase tracking-[0.16em] text-muted-foreground">
						<ShieldCheck className="h-4 w-4 text-primary" />
						Private Mail Console
					</div>
					<h1 className="text-2xl font-bold text-slate-100">
						{setupNeeded ? 'Create the admin account' : 'Auth Inbox'}
					</h1>
					<p className="mt-1 text-sm text-muted-foreground">
						{setupNeeded
							? 'This inbox has no users yet. The first account becomes the admin.'
							: 'Sign in to read your verification mail.'}
					</p>
				</div>

				<div className="space-y-4">
					<div className="space-y-1.5">
						<Label htmlFor="username">Username</Label>
						<Input
							id="username"
							autoComplete="username"
							autoFocus
							value={username}
							onChange={(event) => setUsername(event.target.value)}
							onKeyDown={(event) => event.key === 'Enter' && submit()}
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="password">Password</Label>
						<Input
							id="password"
							type="password"
							autoComplete={setupNeeded ? 'new-password' : 'current-password'}
							value={password}
							onChange={(event) => setPassword(event.target.value)}
							onKeyDown={(event) => event.key === 'Enter' && submit()}
						/>
						{setupNeeded ? <p className="text-xs text-muted-foreground">At least 8 characters.</p> : null}
					</div>
					<Button className="w-full" onClick={submit} disabled={isSubmitting}>
						{isSubmitting ? 'Signing in…' : setupNeeded ? 'Create admin and sign in' : 'Sign in'}
					</Button>
				</div>
			</Card>
		</div>
	);
}
