//! Deployed WASM fixture for host/fork integration tests, not protocol replacement code.
#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env};

#[derive(Clone)]
#[contracttype]
enum Key {
    Admin,
    Fee,
    Covenant,
    Staleness,
}
#[contract]
pub struct Parameters;
#[contractimpl]
impl Parameters {
    pub fn __constructor(env: Env, admin: Address) {
        env.storage().instance().set(&Key::Admin, &admin);
        env.storage().instance().set(&Key::Fee, &100u32);
        env.storage().instance().set(&Key::Covenant, &150u32);
        env.storage().instance().set(&Key::Staleness, &600u32);
    }
    pub fn set(env: Env, caller: Address, category: u32, value: u32) {
        caller.require_auth();
        assert_eq!(
            caller,
            env.storage()
                .instance()
                .get::<_, Address>(&Key::Admin)
                .unwrap()
        );
        let key = match category {
            0 => Key::Fee,
            1 => Key::Covenant,
            2 => Key::Staleness,
            _ => panic!("category"),
        };
        env.storage().instance().set(&key, &value);
    }
    pub fn impact(env: Env, category: u32, input: u32) -> u32 {
        match category {
            0 => input * env.storage().instance().get::<_, u32>(&Key::Fee).unwrap() / 10_000,
            1 => {
                (input
                    >= env
                        .storage()
                        .instance()
                        .get::<_, u32>(&Key::Covenant)
                        .unwrap()) as u32
            }
            2 => {
                (input
                    <= env
                        .storage()
                        .instance()
                        .get::<_, u32>(&Key::Staleness)
                        .unwrap()) as u32
            }
            _ => panic!("category"),
        }
    }
}
