import { Injectable, inject, signal, computed } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { WalletService } from './wallet.service';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly walletService = inject(WalletService);

  readonly token = signal<string | null>(localStorage.getItem('nbs_access_token'));
  readonly isAuthenticated = computed(() => this.token() !== null);

  private isRetryableChallengeError(err: unknown): boolean {
    if (!(err instanceof HttpErrorResponse)) return false;
    const detail =
      (err.error as { detail?: string } | null)?.detail ??
      (err.error as { message?: string } | null)?.message ??
      err.message;
    return typeof detail === 'string' && /request a fresh challenge/i.test(detail);
  }

  private async challengeFor(address: string): Promise<{ challenge: string; nonce: string }> {
    return firstValueFrom(
      this.http.post<{ challenge: string; nonce: string }>('/api/auth/challenge', { address }),
    );
  }

  private async verifyFor(args: {
    address: string;
    signedChallenge: string;
    originalChallenge: string;
  }): Promise<{ accessToken: string; refreshToken: string }> {
    return firstValueFrom(
      this.http.post<{ accessToken: string; refreshToken: string }>('/api/auth/verify', args),
    );
  }

  async login(): Promise<void> {
    const address = this.walletService.address();
    if (!address) throw new Error('Wallet not connected');

    let attempt = 0;
    const maxAttempts = 2;

    while (attempt < maxAttempts) {
      attempt += 1;
      const { challenge } = await this.challengeFor(address);
      const signedChallenge = await this.walletService.signChallenge(challenge);

      try {
        const { accessToken, refreshToken } = await this.verifyFor({
          address,
          signedChallenge,
          originalChallenge: challenge,
        });

        localStorage.setItem('nbs_access_token', accessToken);
        localStorage.setItem('nbs_refresh_token', refreshToken);
        this.token.set(accessToken);
        return;
      } catch (err) {
        const canRetry =
          this.isRetryableChallengeError(err) && attempt < maxAttempts;
        if (!canRetry) throw err;
      }
    }

    throw new Error('Unable to complete wallet authentication');
  }

  async refresh(): Promise<void> {
    const refreshToken = localStorage.getItem('nbs_refresh_token');
    if (!refreshToken) throw new Error('No refresh token available');

    const { accessToken } = await firstValueFrom(
      this.http.post<{ accessToken: string }>('/api/auth/refresh', { refreshToken }),
    );
    localStorage.setItem('nbs_access_token', accessToken);
    this.token.set(accessToken);
  }

  logout(): void {
    localStorage.removeItem('nbs_access_token');
    localStorage.removeItem('nbs_refresh_token');
    this.token.set(null);
    this.walletService.disconnect();
  }
}
