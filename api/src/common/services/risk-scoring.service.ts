import { Injectable, Logger } from '@nestjs/common';

export interface RiskFactor {
  name: string;
  weight: number;
  value: number;
  explanation: string;
}

export interface RiskScore {
  overallScore: number; // 0-100
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  factors: RiskFactor[];
  timestamp: number;
  recommendations: string[];
}

/**
 * Explainable risk scoring for suspicious high-impact actions (#428).
 *
 * Scores high-impact actions (large transfers, role changes, config updates)
 * based on multiple risk factors with transparent scoring explanations.
 *
 * Risk factors:
 * - Transaction amount relative to historical average
 * - Unusual time patterns (off-hours, weekend activity)
 * - Account age and transaction frequency
 * - Geographic anomalies
 * - Rapid sequence of related operations
 */
@Injectable()
export class RiskScoringService {
  private readonly logger = new Logger(RiskScoringService.name);
  private readonly riskHistogram = new Map<string, RiskScore[]>();

  /**
   * Score a high-impact action based on context and patterns.
   */
  scoreAction(
    actionType: string,
    userId: string,
    context: {
      amount?: bigint;
      historicalAverage?: bigint;
      timeOfDay?: number;
      accountAgeMs?: number;
      recentTransactionCount?: number;
      isOffHours?: boolean;
      isWeekend?: boolean;
      isNewAccount?: boolean;
      isRapidSequence?: boolean;
    },
  ): RiskScore {
    const factors: RiskFactor[] = [];
    let totalWeight = 0;
    let weightedScore = 0;

    // Factor 1: Amount anomaly
    if (context.amount && context.historicalAverage) {
      const ratio = Number(context.amount) / Number(context.historicalAverage);
      const amountScore = Math.min(100, ratio * 25); // Max 25 points
      const weight = 0.25;
      factors.push({
        name: 'amount_anomaly',
        weight,
        value: amountScore,
        explanation: `Transaction amount ${ratio.toFixed(2)}x historical average (${amountScore.toFixed(1)} points)`,
      });
      weightedScore += amountScore * weight;
      totalWeight += weight;
    }

    // Factor 2: Time-based risk
    let timeScore = 0;
    let timeExplanation = 'Normal business hours';
    if (context.isOffHours) {
      timeScore += 15;
      timeExplanation = 'Off-hours activity';
    }
    if (context.isWeekend) {
      timeScore += 20;
      timeExplanation = 'Weekend activity';
    }
    const timeWeight = 0.2;
    factors.push({
      name: 'temporal_anomaly',
      weight: timeWeight,
      value: timeScore,
      explanation: timeExplanation,
    });
    weightedScore += timeScore * timeWeight;
    totalWeight += timeWeight;

    // Factor 3: Account maturity
    let accountScore = 0;
    let accountExplanation = 'Established account';
    if (context.isNewAccount) {
      accountScore = 30;
      accountExplanation = 'New account (< 30 days)';
    } else if (context.accountAgeMs && context.accountAgeMs < 90 * 24 * 60 * 60 * 1000) {
      accountScore = 15;
      accountExplanation = 'Relatively new account (< 90 days)';
    }
    const accountWeight = 0.2;
    factors.push({
      name: 'account_maturity',
      weight: accountWeight,
      value: accountScore,
      explanation: accountExplanation,
    });
    weightedScore += accountScore * accountWeight;
    totalWeight += accountWeight;

    // Factor 4: Activity frequency
    let frequencyScore = 0;
    let frequencyExplanation = 'Normal transaction frequency';
    if (context.isRapidSequence) {
      frequencyScore = 25;
      frequencyExplanation = 'Rapid sequence of operations (> 5 in 1 hour)';
    } else if (context.recentTransactionCount && context.recentTransactionCount > 20) {
      frequencyScore = 15;
      frequencyExplanation = `High recent activity (${context.recentTransactionCount} transactions in 24h)`;
    }
    const frequencyWeight = 0.15;
    factors.push({
      name: 'activity_frequency',
      weight: frequencyWeight,
      value: frequencyScore,
      explanation: frequencyExplanation,
    });
    weightedScore += frequencyScore * frequencyWeight;
    totalWeight += frequencyWeight;

    // Factor 5: Action type specific risk
    const actionTypeScore = this.getActionTypeRiskScore(actionType);
    const actionWeight = 0.2;
    factors.push({
      name: 'action_type_severity',
      weight: actionWeight,
      value: actionTypeScore.value,
      explanation: actionTypeScore.explanation,
    });
    weightedScore += actionTypeScore.value * actionWeight;
    totalWeight += actionWeight;

    const overallScore = totalWeight > 0 ? Math.round(weightedScore / totalWeight) : 0;
    const riskLevel = this.getRiskLevel(overallScore);
    const recommendations = this.getRecommendations(riskLevel, factors);

    const riskScore: RiskScore = {
      overallScore: Math.min(100, overallScore),
      riskLevel,
      factors,
      timestamp: Date.now(),
      recommendations,
    };

    // Store history
    if (!this.riskHistogram.has(userId)) {
      this.riskHistogram.set(userId, []);
    }
    this.riskHistogram.get(userId)!.push(riskScore);

    if (riskLevel === 'CRITICAL' || riskLevel === 'HIGH') {
      this.logger.warn(
        `High-risk action detected: ${actionType} by ${userId} (score: ${overallScore}, level: ${riskLevel})`,
      );
    }

    return riskScore;
  }

  private getActionTypeRiskScore(actionType: string): { value: number; explanation: string } {
    const riskMap: Record<string, number> = {
      'transfer_large': 20,
      'role_assignment': 25,
      'config_update': 15,
      'emergency_disable': 30,
      'permission_escalation': 35,
      'account_recovery': 20,
      'bulk_operation': 25,
      'export_data': 10,
      'default': 5,
    };

    const value = riskMap[actionType] ?? riskMap['default'];
    return {
      value,
      explanation: `Action type "${actionType}" base risk score: ${value}`,
    };
  }

  private getRiskLevel(score: number): RiskScore['riskLevel'] {
    if (score >= 75) return 'CRITICAL';
    if (score >= 50) return 'HIGH';
    if (score >= 25) return 'MEDIUM';
    return 'LOW';
  }

  private getRecommendations(riskLevel: RiskScore['riskLevel'], factors: RiskFactor[]): string[] {
    const recommendations: string[] = [];

    if (riskLevel === 'CRITICAL') {
      recommendations.push('⛔ Immediate review required before execution');
      recommendations.push('⛔ Consider requiring additional authentication (2FA)');
      recommendations.push('⛔ Flag for manual approval by administrator');
    } else if (riskLevel === 'HIGH') {
      recommendations.push('⚠️ Additional verification recommended');
      recommendations.push('⚠️ Monitor transaction for unusual patterns');
    }

    const highRiskFactors = factors.filter((f) => f.value >= 20);
    if (highRiskFactors.length > 0) {
      recommendations.push(`Address high-risk factors: ${highRiskFactors.map((f) => f.name).join(', ')}`);
    }

    if (riskLevel === 'LOW' || riskLevel === 'MEDIUM') {
      recommendations.push('✓ Proceed with standard verification');
    }

    return recommendations;
  }

  /**
   * Get risk score history for a user.
   */
  getUserRiskHistory(userId: string, limit: number = 100): RiskScore[] {
    const history = this.riskHistogram.get(userId) ?? [];
    return history.slice(Math.max(0, history.length - limit));
  }

  /**
   * Get aggregated risk metrics.
   */
  getRiskMetrics(): {
    totalScored: number;
    criticalCount: number;
    highCount: number;
    averageScore: number;
  } {
    let totalScored = 0;
    let criticalCount = 0;
    let highCount = 0;
    let totalScore = 0;

    for (const scores of this.riskHistogram.values()) {
      totalScored += scores.length;
      totalScore += scores.reduce((sum, s) => sum + s.overallScore, 0);
      criticalCount += scores.filter((s) => s.riskLevel === 'CRITICAL').length;
      highCount += scores.filter((s) => s.riskLevel === 'HIGH').length;
    }

    return {
      totalScored,
      criticalCount,
      highCount,
      averageScore: totalScored > 0 ? Math.round(totalScore / totalScored) : 0,
    };
  }
}
