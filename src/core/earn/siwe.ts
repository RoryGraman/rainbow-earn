import { Address, Hex, sha256, toBytes } from 'viem';

import type { SiweBody } from './types';

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(',')}}`;
}

export function payloadHash(payload: Record<string, unknown>): string {
  return sha256(toBytes(canonicalize(payload))).slice(2);
}

const randomNonce = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

export function buildSiweMessage({
  domain,
  address,
  action,
  uri,
  chainId,
  nonce,
  issuedAt,
  expiresAt,
  payloadHash: hash,
  path,
}: {
  domain: string;
  address: string;
  action: string;
  uri: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  payloadHash: string;
  path: string;
}): string {
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    address,
    '',
    `Authorize ${action}`,
    '',
    `URI: ${uri}`,
    'Version: 1',
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expiration Time: ${expiresAt}`,
    'Resources:',
    `- sha256:${hash}`,
    `- path:${path.split('?')[0].toLowerCase()}`,
  ].join('\n');
}

const FIVE_MINUTES_MS = 5 * 60 * 1000;

export async function signWrite<T extends Record<string, unknown>>({
  action,
  payload,
  domain,
  uri,
  chainId,
  path,
  address,
  sign,
  now = Date.now(),
  nonce = randomNonce(),
  expirationMs = FIVE_MINUTES_MS,
}: {
  action: string;
  payload: T;
  domain: string;
  uri: string;
  chainId: number;
  path: string;
  address: Address;
  sign: (message: string) => Promise<Hex>;
  now?: number;
  nonce?: string;
  expirationMs?: number;
}): Promise<SiweBody<T>> {
  const message = buildSiweMessage({
    domain,
    address,
    action,
    uri,
    chainId,
    nonce,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + expirationMs).toISOString(),
    payloadHash: payloadHash(payload),
    path,
  });
  const signature = await sign(message);
  return { ...payload, siwe: { message, signature } };
}
