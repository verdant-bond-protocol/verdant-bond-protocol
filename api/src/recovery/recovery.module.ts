import { Module } from '@nestjs/common';
import { RecoveryService } from './recovery.service';
import { RecoveryController } from './recovery.controller';
import { RollbackVerificationService } from './rollback-verification.service';
import { IncidentDrillService } from './incident-drill.service';
import { BondStateMachine, CouponStateMachine, SettlementStateMachine } from '../bonds/bond.state-machine';
import { NotificationsModule } from '../notifications/notifications.module';
import { ReconciliationModule } from '../reconciliation/reconciliation.module';
import { SnapshotRestoreVerificationService } from './snapshot-restore-verification.service';
import { SideEffectCheckpointService } from './side-effect-checkpoint.service';

@Module({
  imports: [NotificationsModule, ReconciliationModule],
  controllers: [RecoveryController],
  providers: [
    RecoveryService,
    RollbackVerificationService,
    IncidentDrillService,
    SnapshotRestoreVerificationService,
    SideEffectCheckpointService,
    BondStateMachine,
    CouponStateMachine,
    SettlementStateMachine,
  ],
  exports: [
    RecoveryService,
    RollbackVerificationService,
    IncidentDrillService,
    SnapshotRestoreVerificationService,
    SideEffectCheckpointService,
  ],
})
export class RecoveryModule {}
