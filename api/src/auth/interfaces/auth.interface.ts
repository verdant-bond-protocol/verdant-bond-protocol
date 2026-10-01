export interface ChallengeResponse {
  challenge: string;
  nonce: string;
}

export interface AuthTokenResponse {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresIn: string;
  refreshExpiresIn?: string;
}

export interface UserProfileResponse {
  walletAddress: string;
  kycStatus: string;
  roles: string[];
  permissions: string[];
  createdAt: string;
}
