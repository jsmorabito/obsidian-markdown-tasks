/**
 * Browser sign-in for Linear: OAuth 2.0 authorization code flow with PKCE.
 *
 * PKCE means no client secret ships with the plugin. The user's browser opens
 * Linear's consent page; Linear redirects to `obsidian://markdown-tasks-linear-auth`
 * (directly, or through an HTTPS page that forwards there), Obsidian hands the
 * query to our protocol handler, and the code is exchanged for tokens.
 */

import { Notice, requestUrl } from "obsidian";

export const LINEAR_OAUTH_PROTOCOL_ACTION = "markdown-tasks-linear-auth";
export const DEFAULT_LINEAR_REDIRECT_URI = `obsidian://${LINEAR_OAUTH_PROTOCOL_ACTION}`;

const AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const TOKEN_URL = "https://api.linear.app/oauth/token";
const SCOPES = ["read", "write", "issues:create"];
/** How long a started sign-in waits for its callback. */
const PENDING_TTL_MS = 10 * 60_000;

export interface LinearOAuthTokens {
	accessToken: string;
	refreshToken?: string;
	/** Epoch milliseconds; absent when Linear didn't say. */
	expiresAt?: number;
}

function base64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(byteLength = 32): string {
	return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function pkceChallenge(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return base64Url(new Uint8Array(digest));
}

/** Linear answered the token request and refused it (as opposed to a network failure). */
export class LinearTokenRejectedError extends Error {}

async function postToken(body: Record<string, string>): Promise<LinearOAuthTokens> {
	const res = await requestUrl({
		url: TOKEN_URL,
		method: "POST",
		throw: false,
		contentType: "application/x-www-form-urlencoded",
		body: new URLSearchParams(body).toString(),
	});
	const json = (res.json ?? {}) as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
		error?: string;
		error_description?: string;
	};
	if (res.status < 200 || res.status >= 300 || !json.access_token) {
		throw new LinearTokenRejectedError(json.error_description ?? json.error ?? `Linear token request failed (HTTP ${res.status})`);
	}
	return {
		accessToken: json.access_token,
		refreshToken: json.refresh_token,
		expiresAt: typeof json.expires_in === "number" ? Date.now() + json.expires_in * 1000 : undefined,
	};
}

/** Trade a refresh token for new tokens. Linear rotates refresh tokens, so store the new one. */
export function refreshLinearTokens(clientId: string, refreshToken: string): Promise<LinearOAuthTokens> {
	return postToken({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId });
}

interface PendingSignIn {
	workspaceId: string;
	clientId: string;
	redirectUri: string;
	verifier: string;
	expiresAt: number;
}

/** The callback's query parameters, as Obsidian's protocol handler passes them. */
export type OAuthCallbackParams = { [key: string]: string | undefined; code?: string; state?: string; error?: string; error_description?: string };

/** Tracks sign-ins started in the browser until Linear redirects back. */
export class LinearOAuthFlow {
	private pending = new Map<string, PendingSignIn>();

	constructor(
		private onTokens: (workspaceId: string, clientId: string, tokens: LinearOAuthTokens) => Promise<void>
	) {}

	/** Open Linear's consent page for `workspaceId` in the browser. */
	async start(workspaceId: string, clientId: string, redirectUri: string): Promise<void> {
		const verifier = randomString(48);
		const state = randomString(16);
		this.pending.set(state, {
			workspaceId,
			clientId,
			redirectUri,
			verifier,
			expiresAt: Date.now() + PENDING_TTL_MS,
		});
		const params = new URLSearchParams({
			client_id: clientId,
			redirect_uri: redirectUri,
			response_type: "code",
			scope: SCOPES.join(","),
			state,
			code_challenge: await pkceChallenge(verifier),
			code_challenge_method: "S256",
			// Always show the consent screen, so a second workspace can be picked.
			prompt: "consent",
			actor: "user",
		});
		window.open(`${AUTHORIZE_URL}?${params.toString()}`);
	}

	/** Handle the `obsidian://markdown-tasks-linear-auth?code=…&state=…` callback. */
	async handleCallback(params: OAuthCallbackParams): Promise<void> {
		const now = Date.now();
		for (const [key, p] of this.pending) if (p.expiresAt < now) this.pending.delete(key);

		const signIn = params.state ? this.pending.get(params.state) : undefined;
		if (!signIn) {
			new Notice("Linear sign-in expired or wasn't started here. Select connect again.");
			return;
		}
		this.pending.delete(params.state!);
		if (params.error || !params.code) {
			new Notice(`Linear sign-in canceled: ${params.error_description ?? params.error ?? "no code returned"}`);
			return;
		}

		try {
			const tokens = await postToken({
				grant_type: "authorization_code",
				code: params.code,
				redirect_uri: signIn.redirectUri,
				client_id: signIn.clientId,
				code_verifier: signIn.verifier,
			});
			await this.onTokens(signIn.workspaceId, signIn.clientId, tokens);
		} catch (err) {
			new Notice(`Linear sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}
