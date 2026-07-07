export interface User {
	id: number;
	username: string;
	role: 'admin' | 'user';
}

export interface MailListItem {
	id: number;
	messageId: string | null;
	fromOrg: string | null;
	fromAddr: string | null;
	toAddr: string | null;
	topic: string | null;
	code: string | null;
	category: string;
	createdAt: string | null;
	subject: string | null;
}

export interface MailListResponse {
	page: number;
	pageSize: number;
	total: number;
	items: MailListItem[];
}

// raw / textBody / htmlBody 只有 admin 的响应里才有
export interface MailDetail extends MailListItem {
	raw?: string | null;
	textBody?: string | null;
	htmlBody?: string | null;
}

export interface ApiKeyItem {
	id: number;
	name: string;
	createdAt: string | null;
	lastUsedAt: string | null;
}

export interface GrantItem {
	id: number;
	userId: number;
	username: string;
	addressPattern: string;
	allowedCategories: string; // JSON string from backend
	allowSensitive: number;
	createdAt: string | null;
}

export interface UserItem {
	id: number;
	username: string;
	role: 'admin' | 'user';
	createdAt: string | null;
}

// 与后端 MAIL_CATEGORIES 保持一致
export const CATEGORIES = [
	'login_code',
	'registration',
	'password_reset',
	'account_security',
	'payment',
	'other',
] as const;

export const SENSITIVE_CATEGORIES = ['password_reset', 'account_security', 'legacy'];

export const CATEGORY_LABELS: Record<string, string> = {
	login_code: 'Login code',
	registration: 'Registration',
	password_reset: 'Password reset',
	account_security: 'Account security',
	payment: 'Payment',
	other: 'Other',
	legacy: 'Legacy',
};

export class ApiError extends Error {
	status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
	const response = await fetch(url, {
		...init,
		headers: {
			Accept: 'application/json',
			...(init?.body ? { 'Content-Type': 'application/json' } : {}),
			...init?.headers,
		},
	});

	if (!response.ok) {
		let message = `Request failed (${response.status})`;
		try {
			const body = (await response.json()) as { error?: string };
			if (body.error) message = body.error;
		} catch {
			// keep default message
		}
		throw new ApiError(response.status, message);
	}
	return (await response.json()) as T;
}

export function getJson<T>(url: string): Promise<T> {
	return request<T>(url);
}

export function postJson<T>(url: string, body?: unknown): Promise<T> {
	return request<T>(url, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
}

export function deleteJson<T>(url: string): Promise<T> {
	return request<T>(url, { method: 'DELETE' });
}
