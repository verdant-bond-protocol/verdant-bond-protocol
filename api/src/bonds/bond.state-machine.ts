import { Injectable, Logger } from '@nestjs/common';

export enum BondState {
    DRAFT = 'DRAFT',
    ISSUED = 'ISSUED',
    ACTIVE = 'ACTIVE',
    DEFAULTED = 'DEFAULTED',
    MATURED = 'MATURED',
}

export enum BondEvent {
    PUBLISH = 'PUBLISH',
    FUND = 'FUND',
    MISS_PAYMENT = 'MISS_PAYMENT',
    REPAY_FULL = 'REPAY_FULL',
}

@Injectable()
export class BondStateMachine {
    private readonly logger = new Logger(BondStateMachine.name);
    
    private readonly transitions: Record<BondState, Partial<Record<BondEvent, BondState>>> = {
        [BondState.DRAFT]: {
            [BondEvent.PUBLISH]: BondState.ISSUED,
        },
        [BondState.ISSUED]: {
            [BondEvent.FUND]: BondState.ACTIVE,
        },
        [BondState.ACTIVE]: {
            [BondEvent.MISS_PAYMENT]: BondState.DEFAULTED,
            [BondEvent.REPAY_FULL]: BondState.MATURED,
        },
        [BondState.DEFAULTED]: {},
        [BondState.MATURED]: {},
    };

    transition(currentState: BondState, event: BondEvent): BondState {
        const allowed = this.transitions[currentState];
        const nextState = allowed[event];
        
        if (!nextState) {
            const errorMsg = `Invalid state transition from ${currentState} via ${event}`;
            this.logger.error(errorMsg);
            throw new Error(errorMsg);
        }
        
        this.logger.log(`Bond transitioned from ${currentState} to ${nextState} via ${event}`);
        // Emitting audit log internally...
        return nextState;
    }
}
