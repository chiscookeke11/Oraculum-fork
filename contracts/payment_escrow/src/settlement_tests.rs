// contracts/payment_escrow/src/settlement_tests.rs
#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::Address as _,
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, String,
};

const DISPUTE_WINDOW: u64 = 86_400;

fn setup_contract(env: &Env) -> Address {
    env.register(PaymentEscrowContract, ())
}

fn setup_token(env: &Env, admin: &Address, depositor: &Address, amount: i128) -> Address {
    let token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    StellarAssetClient::new(env, &token)
        .mock_all_auths()
        .mint(depositor, &amount);
    token
}

fn init<'a>(
    env: &'a Env,
    contract_id: &Address,
    admin: &Address,
    token: &Address,
) -> PaymentEscrowContractClient<'a> {
    let client = PaymentEscrowContractClient::new(env, contract_id);
    client.initialize(admin, token, &DISPUTE_WINDOW, admin, &0u32);
    client
}

fn create_test_escrow(
    env: &Env,
    client: &PaymentEscrowContractClient,
    depositor: &Address,
    beneficiary: &Address,
    id: &str,
) {
    client.create_escrow(
        depositor,
        &String::from_str(env, id),
        beneficiary,
        &5_000i128,
        &String::from_str(env, "Settlement ordering regression test"),
        &0u64,
    );
}

#[test]
fn release_then_refund_is_rejected_without_moving_funds_again() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let depositor = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let token = setup_token(&env, &admin, &depositor, 10_000);
    let contract_id = setup_contract(&env);
    let client = init(&env, &contract_id, &admin, &token);
    let escrow_id = String::from_str(&env, "release-first");

    create_test_escrow(&env, &client, &depositor, &beneficiary, "release-first");
    client.release(&admin, &escrow_id);

    let released = client.get_escrow(&escrow_id);
    assert_eq!(released.status, EscrowStatus::Released);
    assert!(released.resolved_at.is_some());

    let depositor_balance = TokenClient::new(&env, &token).balance(&depositor);
    let beneficiary_balance = TokenClient::new(&env, &token).balance(&beneficiary);
    let contract_balance = TokenClient::new(&env, &token).balance(&contract_id);

    assert_eq!(
        client.try_refund(&admin, &escrow_id),
        Err(Ok(Error::EscrowAlreadySettled))
    );
    assert_eq!(TokenClient::new(&env, &token).balance(&depositor), depositor_balance);
    assert_eq!(TokenClient::new(&env, &token).balance(&beneficiary), beneficiary_balance);
    assert_eq!(TokenClient::new(&env, &token).balance(&contract_id), contract_balance);
}

#[test]
fn refund_then_release_is_rejected_without_moving_funds_again() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let depositor = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let token = setup_token(&env, &admin, &depositor, 10_000);
    let contract_id = setup_contract(&env);
    let client = init(&env, &contract_id, &admin, &token);
    let escrow_id = String::from_str(&env, "refund-first");

    create_test_escrow(&env, &client, &depositor, &beneficiary, "refund-first");
    client.refund(&admin, &escrow_id);

    let refunded = client.get_escrow(&escrow_id);
    assert_eq!(refunded.status, EscrowStatus::Refunded);
    assert!(refunded.resolved_at.is_some());

    let depositor_balance = TokenClient::new(&env, &token).balance(&depositor);
    let beneficiary_balance = TokenClient::new(&env, &token).balance(&beneficiary);
    let contract_balance = TokenClient::new(&env, &token).balance(&contract_id);

    assert_eq!(
        client.try_release(&admin, &escrow_id),
        Err(Ok(Error::EscrowAlreadySettled))
    );
    assert_eq!(TokenClient::new(&env, &token).balance(&depositor), depositor_balance);
    assert_eq!(TokenClient::new(&env, &token).balance(&beneficiary), beneficiary_balance);
    assert_eq!(TokenClient::new(&env, &token).balance(&contract_id), contract_balance);
}
