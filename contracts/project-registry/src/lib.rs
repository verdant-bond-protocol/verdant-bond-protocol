#![no_std]
use nbbs_shared::{ProjectStatus, RegistryError};
use soroban_sdk::{
    contract, contractimpl, contracttype, events::Event, vec, Address, BytesN, Env, IntoVal,
    Symbol, Val, Vec,
};

#[derive(Clone)]
pub enum RegistryEvent {
    ProjectRegistered {
        id: u64,
        owner: Address,
        methodology: Symbol,
        country: Symbol,
    },
    ProjectApproved {
        id: u64,
        caller: Address,
    },
    ProjectRejected {
        id: u64,
        caller: Address,
    },
    AdminChanged {
        prev: Address,
        new: Address,
    },
}

impl Event for RegistryEvent {
    fn topics(&self, env: &Env) -> Vec<Val> {
        let name = match self {
            RegistryEvent::ProjectRegistered { .. } => "project_registered",
            RegistryEvent::ProjectApproved { .. } => "project_approved",
            RegistryEvent::ProjectRejected { .. } => "project_rejected",
            RegistryEvent::AdminChanged { .. } => "admin_changed",
        };
        vec![&env, Symbol::new(env, name).into_val(env)]
    }

    fn data(&self, env: &Env) -> Val {
        match self {
            RegistryEvent::ProjectRegistered {
                id,
                owner,
                methodology,
                country,
            } => (*id, owner.clone(), methodology.clone(), country.clone()).into_val(env),
            RegistryEvent::ProjectApproved { id, caller } => (*id, caller.clone()).into_val(env),
            RegistryEvent::ProjectRejected { id, caller } => (*id, caller.clone()).into_val(env),
            RegistryEvent::AdminChanged { prev, new } => (prev.clone(), new.clone()).into_val(env),
        }
    }
}

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    Project(BytesN<32>),
    ProjectCount,
    ProjectId(u64),
    Nonce(Address),
    OwnerProjects(Address),
    ProjectDocuments(u64),
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct Project {
    pub id: u64,
    pub owner: Address,
    pub metadata_ipfs_hash: BytesN<32>,
    pub status: ProjectStatus,
    pub methodology: Symbol,
    pub country: Symbol,
}

#[derive(Clone)]
#[contracttype]
pub struct ProjectSummary {
    pub id: u64,
    pub name: Symbol,
    pub status: ProjectStatus,
    pub country: Symbol,
}

const MAX_DOCUMENTS: u32 = 10;

fn project_id_to_bytes(env: &Env, id: u64) -> BytesN<32> {
    let mut arr = [0u8; 32];
    arr[..8].copy_from_slice(&id.to_be_bytes());
    BytesN::from_array(env, &arr)
}

fn require_admin(env: &Env, caller: &Address) -> Result<(), RegistryError> {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(RegistryError::NotInitialized)?;
    if caller != &admin {
        return Err(RegistryError::Unauthorized);
    }
    Ok(())
}

fn get_nonce(env: &Env, addr: &Address) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::Nonce(addr.clone()))
        .unwrap_or(0)
}

fn set_nonce(env: &Env, addr: &Address, nonce: u64) {
    env.storage()
        .instance()
        .set(&DataKey::Nonce(addr.clone()), &nonce);
}

#[contract]
pub struct ProjectRegistry;

#[contractimpl]
impl ProjectRegistry {
    pub fn __constructor(env: Env, admin: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    pub fn get_nonce(env: Env, address: Address) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::Nonce(address))
            .unwrap_or(0)
    }

    pub fn register_project(
        env: Env,
        caller: Address,
        metadata_ipfs_hash: BytesN<32>,
        methodology: Symbol,
        country: Symbol,
        nonce: u64,
    ) -> Result<u64, RegistryError> {
        caller.require_auth();

        let expected_nonce: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::Nonce(caller.clone()))
            .unwrap_or(0);
        if nonce != expected_nonce {
            return Err(RegistryError::InvalidNonce);
        }
        env.storage()
            .persistent()
            .set(&DataKey::Nonce(caller.clone()), &(expected_nonce + 1));

        let hash_arr = metadata_ipfs_hash.to_array();
        if hash_arr.iter().all(|&b| b == 0) {
            return Err(RegistryError::ProjectNotFound);
        }

        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ProjectCount)
            .unwrap_or(0);
        let new_id = count + 1;
        env.storage()
            .instance()
            .set(&DataKey::ProjectCount, &new_id);

        let project = Project {
            id: new_id,
            owner: caller.clone(),
            metadata_ipfs_hash,
            status: ProjectStatus::Pending,
            methodology,
            country,
        };

        let key = project_id_to_bytes(&env, new_id);
        env.storage()
            .instance()
            .set(&DataKey::Project(key), &project);

        env.events()
            .publish_event(&RegistryEvent::ProjectRegistered {
                id: new_id,
                owner: caller.clone(),
                methodology: project.methodology.clone(),
                country: project.country.clone(),
            });

        let mut owner_projects: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::OwnerProjects(caller.clone()))
            .unwrap_or(vec![&env]);
        owner_projects.push_back(new_id);
        env.storage()
            .instance()
            .set(&DataKey::OwnerProjects(caller), &owner_projects);

        Ok(new_id)
    }

    pub fn approve_project(
        env: Env,
        caller: Address,
        project_id: u64,
        nonce: u64,
    ) -> Result<(), RegistryError> {
        caller.require_auth();

        let expected_nonce: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::Nonce(caller.clone()))
            .unwrap_or(0);
        if nonce != expected_nonce {
            return Err(RegistryError::InvalidNonce);
        }
        env.storage()
            .persistent()
            .set(&DataKey::Nonce(caller.clone()), &(expected_nonce + 1));

        require_admin(&env, &caller)?;

        let key = project_id_to_bytes(&env, project_id);
        let mut project: Project = env
            .storage()
            .instance()
            .get(&DataKey::Project(key.clone()))
            .ok_or(RegistryError::ProjectNotFound)?;

        if project.status != ProjectStatus::Pending {
            return Err(RegistryError::InvalidStatusTransition);
        }

        project.status = ProjectStatus::Approved;
        env.storage()
            .instance()
            .set(&DataKey::Project(key), &project);

        env.events().publish_event(&RegistryEvent::ProjectApproved {
            id: project_id,
            caller,
        });

        Ok(())
    }

    pub fn reject_project(
        env: Env,
        caller: Address,
        project_id: u64,
        nonce: u64,
    ) -> Result<(), RegistryError> {
        caller.require_auth();

        let expected_nonce: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::Nonce(caller.clone()))
            .unwrap_or(0);
        if nonce != expected_nonce {
            return Err(RegistryError::InvalidNonce);
        }
        env.storage()
            .persistent()
            .set(&DataKey::Nonce(caller.clone()), &(expected_nonce + 1));

        require_admin(&env, &caller)?;

        let key = project_id_to_bytes(&env, project_id);
        let mut project: Project = env
            .storage()
            .instance()
            .get(&DataKey::Project(key.clone()))
            .ok_or(RegistryError::ProjectNotFound)?;

        if project.status != ProjectStatus::Pending {
            return Err(RegistryError::InvalidStatusTransition);
        }

        project.status = ProjectStatus::Rejected;
        env.storage()
            .instance()
            .set(&DataKey::Project(key), &project);

        env.events().publish_event(&RegistryEvent::ProjectRejected {
            id: project_id,
            caller,
        });

        Ok(())
    }

    pub fn deactivate_project(
        env: Env,
        caller: Address,
        project_id: u64,
        nonce: u64,
    ) -> Result<(), RegistryError> {
        caller.require_auth();

        let expected_nonce: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::Nonce(caller.clone()))
            .unwrap_or(0);
        if nonce != expected_nonce {
            return Err(RegistryError::InvalidNonce);
        }
        env.storage()
            .persistent()
            .set(&DataKey::Nonce(caller.clone()), &(expected_nonce + 1));

        require_admin(&env, &caller)?;

        let key = project_id_to_bytes(&env, project_id);
        let mut project: Project = env
            .storage()
            .instance()
            .get(&DataKey::Project(key.clone()))
            .ok_or(RegistryError::ProjectNotFound)?;

        if project.status != ProjectStatus::Approved {
            return Err(RegistryError::InvalidStatusTransition);
        }

        project.status = ProjectStatus::Inactive;
        env.storage()
            .instance()
            .set(&DataKey::Project(key), &project);

        Ok(())
    }

    pub fn resubmit_project(
        env: Env,
        caller: Address,
        project_id: u64,
        updated_ipfs_hash: BytesN<32>,
        nonce: u64,
    ) -> Result<(), RegistryError> {
        caller.require_auth();

        let expected_nonce: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::Nonce(caller.clone()))
            .unwrap_or(0);
        if nonce != expected_nonce {
            return Err(RegistryError::InvalidNonce);
        }
        env.storage()
            .persistent()
            .set(&DataKey::Nonce(caller.clone()), &(expected_nonce + 1));

        let key = project_id_to_bytes(&env, project_id);
        let mut project: Project = env
            .storage()
            .instance()
            .get(&DataKey::Project(key.clone()))
            .ok_or(RegistryError::ProjectNotFound)?;

        if project.owner != caller {
            return Err(RegistryError::Unauthorized);
        }

        if project.status != ProjectStatus::Rejected {
            return Err(RegistryError::InvalidStatusTransition);
        }

        project.metadata_ipfs_hash = updated_ipfs_hash;
        project.status = ProjectStatus::Pending;
        env.storage()
            .instance()
            .set(&DataKey::Project(key), &project);

        Ok(())
    }

    pub fn has_approved_project(env: Env, key: BytesN<32>) -> bool {
        match env
            .storage()
            .instance()
            .get::<_, Project>(&DataKey::Project(key))
        {
            Some(project) => project.status == ProjectStatus::Approved,
            None => false,
        }
    }

    /// Returns the methodology symbol for a project keyed by its `BytesN<32>`
    /// identifier, or an empty symbol when no such project exists. The
    /// `BondIssuer` cross-invokes this on issuance to enforce methodology /
    /// credit-type compatibility without coupling to the numeric internal id.
    pub fn get_project_methodology(env: Env, key: BytesN<32>) -> Symbol {
        match env
            .storage()
            .instance()
            .get::<_, Project>(&DataKey::Project(key))
        {
            Some(project) => project.methodology,
            None => Symbol::new(&env, ""),
        }
    }

    pub fn project_key(env: Env, project_id: u64) -> BytesN<32> {
        project_id_to_bytes(&env, project_id)
    }

    pub fn get_project(env: Env, project_id: u64) -> Result<Project, RegistryError> {
        let key = project_id_to_bytes(&env, project_id);
        env.storage()
            .instance()
            .get(&DataKey::Project(key))
            .ok_or(RegistryError::ProjectNotFound)
    }

    pub fn list_projects(env: Env, page: u32, page_size: u32) -> Vec<ProjectSummary> {
        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ProjectCount)
            .unwrap_or(0);

        let page_size = page_size.min(50);
        let start = (page as u64) * (page_size as u64);
        let mut result: Vec<ProjectSummary> = vec![&env];

        if start >= count {
            return result;
        }

        let end = (start + page_size as u64).min(count);
        for i in (start + 1)..=end {
            let key = project_id_to_bytes(&env, i);
            if let Some(project) = env
                .storage()
                .instance()
                .get::<_, Project>(&DataKey::Project(key))
            {
                result.push_back(ProjectSummary {
                    id: project.id,
                    name: project.methodology,
                    status: project.status,
                    country: project.country,
                });
            }
        }

        result
    }

    pub fn project_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::ProjectCount)
            .unwrap_or(0)
    }

    pub fn get_owner_projects(env: Env, owner: Address) -> Vec<u64> {
        env.storage()
            .instance()
            .get(&DataKey::OwnerProjects(owner))
            .unwrap_or(vec![&env])
    }

    pub fn add_project_documents(
        env: Env,
        project_id: u64,
        document_hashes: Vec<BytesN<32>>,
    ) -> Result<(), RegistryError> {
        if document_hashes.len() > MAX_DOCUMENTS {
            return Err(RegistryError::InvalidArgument);
        }
        let key = DataKey::ProjectDocuments(project_id);
        env.storage().instance().set(&key, &document_hashes);
        Ok(())
    }

    pub fn get_project_documents(env: Env, project_id: u64) -> Vec<BytesN<32>> {
        let key = DataKey::ProjectDocuments(project_id);
        env.storage().instance().get(&key).unwrap_or(vec![&env])
    }

    pub fn set_admin(
        env: Env,
        current_admin: Address,
        new_admin: Address,
        nonce: u64,
    ) -> Result<(), RegistryError> {
        current_admin.require_auth();

        let expected_nonce = get_nonce(&env, &current_admin);
        if nonce != expected_nonce {
            return Err(RegistryError::InvalidNonce);
        }
        set_nonce(&env, &current_admin, expected_nonce + 1);

        require_admin(&env, &current_admin)?;
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        env.events().publish_event(&RegistryEvent::AdminChanged {
            prev: current_admin,
            new: new_admin,
        });

        Ok(())
    }

    pub fn get_admin(env: Env) -> Result<Address, RegistryError> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(RegistryError::NotInitialized)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    fn create_hash(env: &Env, value: u8) -> BytesN<32> {
        let mut arr = [0u8; 32];
        arr[31] = value;
        BytesN::from_array(env, &arr)
    }

    fn zero_hash(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &[0u8; 32])
    }

    fn setup() -> (Env, ProjectRegistryClient<'static>, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let contract_id = env.register(ProjectRegistry, (&admin,));
        let client = ProjectRegistryClient::new(&env, &contract_id);
        (env, client, admin, user)
    }

    #[test]
    fn test_register_project() {
        let (env, client, _admin, user) = setup();
        let hash = create_hash(&env, 1);

        let id = client.register_project(
            &user,
            &hash,
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );
        assert_eq!(id, 1);

        let project = client.get_project(&1);
        assert_eq!(project.id, 1);
        assert_eq!(project.owner, user);
        assert_eq!(project.status, ProjectStatus::Pending);
        assert_eq!(project.metadata_ipfs_hash, hash);
    }

    #[test]
    fn test_register_project_invalid_nonce() {
        let (env, client, _admin, user) = setup();
        let hash = create_hash(&env, 1);

        let result = client.try_register_project(
            &user,
            &hash,
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &1,
        );
        assert_eq!(result, Err(Ok(RegistryError::InvalidNonce)));
    }

    #[test]
    fn test_register_project_zero_hash() {
        let (env, client, _admin, user) = setup();
        let result = client.try_register_project(
            &user,
            &zero_hash(&env),
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );
        assert_eq!(result, Err(Ok(RegistryError::ProjectNotFound)));
    }

    #[test]
    fn test_approve_project() {
        let (env, client, admin, user) = setup();
        let hash = create_hash(&env, 1);

        let id = client.register_project(
            &user,
            &hash,
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );

        client.approve_project(&admin, &id, &0);

        let project = client.get_project(&id);
        assert_eq!(project.status, ProjectStatus::Approved);
    }

    #[test]
    fn test_reject_project() {
        let (env, client, admin, user) = setup();
        let hash = create_hash(&env, 1);

        let id = client.register_project(
            &user,
            &hash,
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );

        client.reject_project(&admin, &id, &0);

        let project = client.get_project(&id);
        assert_eq!(project.status, ProjectStatus::Rejected);
    }

    #[test]
    fn test_approve_non_existent_project() {
        let (_env, client, admin, _user) = setup();
        let result = client.try_approve_project(&admin, &999, &0);
        assert_eq!(result, Err(Ok(RegistryError::ProjectNotFound)));
    }

    #[test]
    fn test_approve_already_approved() {
        let (env, client, admin, user) = setup();
        let hash = create_hash(&env, 1);

        let id = client.register_project(
            &user,
            &hash,
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );

        client.approve_project(&admin, &id, &0);

        let result = client.try_approve_project(&admin, &id, &1);
        assert_eq!(result, Err(Ok(RegistryError::InvalidStatusTransition)));
    }

    #[test]
    fn test_reject_already_rejected() {
        let (env, client, admin, user) = setup();
        let hash = create_hash(&env, 1);

        let id = client.register_project(
            &user,
            &hash,
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );

        client.reject_project(&admin, &id, &0);

        let result = client.try_reject_project(&admin, &id, &1);
        assert_eq!(result, Err(Ok(RegistryError::InvalidStatusTransition)));
    }

    #[test]
    fn test_approve_unauthorized() {
        let (env, client, _admin, user) = setup();
        let hash = create_hash(&env, 1);

        let id = client.register_project(
            &user,
            &hash,
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );

        let result = client.try_approve_project(&user, &id, &1);
        assert_eq!(result, Err(Ok(RegistryError::Unauthorized)));
    }

    #[test]
    fn test_get_project_not_found() {
        let (_env, client, _admin, _user) = setup();
        let result = client.try_get_project(&999);
        assert_eq!(result, Err(Ok(RegistryError::ProjectNotFound)));
    }

    #[test]
    fn test_project_count() {
        let (env, client, _admin, user) = setup();

        assert_eq!(client.project_count(), 0);

        let hash = create_hash(&env, 1);
        client.register_project(
            &user,
            &hash,
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );
        assert_eq!(client.project_count(), 1);

        let hash2 = create_hash(&env, 2);
        client.register_project(
            &user,
            &hash2,
            &Symbol::new(&env, "GS"),
            &Symbol::new(&env, "BR"),
            &1,
        );
        assert_eq!(client.project_count(), 2);
    }

    #[test]
    fn test_list_projects_pagination() {
        let (env, client, _admin, user) = setup();

        for i in 0..5 {
            let hash = create_hash(&env, (i + 1) as u8);
            client.register_project(
                &user,
                &hash,
                &Symbol::new(&env, "VCS"),
                &Symbol::new(&env, "US"),
                &(i as u64),
            );
        }

        let page1 = client.list_projects(&0, &3);
        assert_eq!(page1.len(), 3);
        assert_eq!(page1.get(0).unwrap().id, 1);
        assert_eq!(page1.get(1).unwrap().id, 2);
        assert_eq!(page1.get(2).unwrap().id, 3);
        // name must be populated from methodology, not blank
        assert_eq!(page1.get(0).unwrap().name, Symbol::new(&env, "VCS"));
        assert_eq!(page1.get(1).unwrap().name, Symbol::new(&env, "VCS"));
        assert_eq!(page1.get(2).unwrap().name, Symbol::new(&env, "VCS"));

        let page2 = client.list_projects(&1, &3);
        assert_eq!(page2.len(), 2);
        assert_eq!(page2.get(0).unwrap().id, 4);
        assert_eq!(page2.get(1).unwrap().id, 5);
        assert_eq!(page2.get(0).unwrap().name, Symbol::new(&env, "VCS"));
        assert_eq!(page2.get(1).unwrap().name, Symbol::new(&env, "VCS"));
    }

    #[test]
    fn test_list_projects_name_matches_methodology() {
        let (env, client, _admin, user) = setup();

        let hash1 = create_hash(&env, 1);
        client.register_project(
            &user,
            &hash1,
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );

        let hash2 = create_hash(&env, 2);
        client.register_project(
            &user,
            &hash2,
            &Symbol::new(&env, "GS"),
            &Symbol::new(&env, "BR"),
            &1,
        );

        let projects = client.list_projects(&0, &10);
        assert_eq!(projects.len(), 2);

        let summary1 = projects.get(0).unwrap();
        assert_eq!(summary1.id, 1);
        assert_eq!(summary1.name, Symbol::new(&env, "VCS"));
        assert_eq!(summary1.country, Symbol::new(&env, "US"));

        let summary2 = projects.get(1).unwrap();
        assert_eq!(summary2.id, 2);
        assert_eq!(summary2.name, Symbol::new(&env, "GS"));
        assert_eq!(summary2.country, Symbol::new(&env, "BR"));
    }

    #[test]
    fn test_get_owner_projects() {
        let (env, client, _admin, user) = setup();
        let user2 = Address::generate(&env);

        let hash1 = create_hash(&env, 1);
        let id1 = client.register_project(
            &user,
            &hash1,
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );

        let hash2 = create_hash(&env, 2);
        let id2 = client.register_project(
            &user,
            &hash2,
            &Symbol::new(&env, "GS"),
            &Symbol::new(&env, "BR"),
            &1,
        );

        let hash3 = create_hash(&env, 3);
        let id3 = client.register_project(
            &user2,
            &hash3,
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "KE"),
            &0,
        );

        let user_projects = client.get_owner_projects(&user);
        assert_eq!(user_projects.len(), 2);
        assert_eq!(user_projects.get(0).unwrap(), id1);
        assert_eq!(user_projects.get(1).unwrap(), id2);

        let user2_projects = client.get_owner_projects(&user2);
        assert_eq!(user2_projects.len(), 1);
        assert_eq!(user2_projects.get(0).unwrap(), id3);
    }

    #[test]
    fn test_list_projects_caps_page_size() {
        let (env, client, _admin, user) = setup();

        for i in 0..60 {
            let hash = create_hash(&env, ((i % 255) + 1) as u8);
            client.register_project(
                &user,
                &hash,
                &Symbol::new(&env, "VCS"),
                &Symbol::new(&env, "US"),
                &(i as u64),
            );
        }

        let result = client.list_projects(&0, &100);
        assert_eq!(result.len(), 50);
    }

    #[test]
    fn test_register_twice_updates_nonce() {
        let (env, client, _admin, user) = setup();
        let hash = create_hash(&env, 1);

        let id1 = client.register_project(
            &user,
            &hash,
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );
        assert_eq!(id1, 1);

        let hash2 = create_hash(&env, 2);
        let id2 = client.register_project(
            &user,
            &hash2,
            &Symbol::new(&env, "GS"),
            &Symbol::new(&env, "BR"),
            &1,
        );
        assert_eq!(id2, 2);
    }

    #[test]
    fn test_deactivate_project() {
        let (env, client, admin, user) = setup();
        let hash = create_hash(&env, 1);
        let id = client.register_project(
            &user,
            &hash,
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );
        client.approve_project(&admin, &id, &0);
        client.deactivate_project(&admin, &id, &1);
        let project = client.get_project(&id);
        assert_eq!(project.status, ProjectStatus::Inactive);
    }

    #[test]
    fn test_deactivate_requires_admin() {
        let (env, client, admin, user) = setup();
        let hash = create_hash(&env, 1);
        let id = client.register_project(
            &user,
            &hash,
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );
        client.approve_project(&admin, &id, &0);
        let result = client.try_deactivate_project(&user, &id, &1);
        assert_eq!(result, Err(Ok(RegistryError::Unauthorized)));
    }

    #[test]
    fn test_deactivate_pending_fails() {
        let (env, client, admin, user) = setup();
        let hash = create_hash(&env, 1);
        let id = client.register_project(
            &user,
            &hash,
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );
        let result = client.try_deactivate_project(&admin, &id, &0);
        assert_eq!(result, Err(Ok(RegistryError::InvalidStatusTransition)));
    }

    #[test]
    fn test_deactivate_rejected_fails() {
        let (env, client, admin, user) = setup();
        let hash = create_hash(&env, 1);
        let id = client.register_project(
            &user,
            &hash,
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );
        client.reject_project(&admin, &id, &0);
        let result = client.try_deactivate_project(&admin, &id, &1);
        assert_eq!(result, Err(Ok(RegistryError::InvalidStatusTransition)));
    }

    #[test]
    fn test_deactivate_already_inactive_fails() {
        let (env, client, admin, user) = setup();
        let hash = create_hash(&env, 1);
        let id = client.register_project(
            &user,
            &hash,
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );
        client.approve_project(&admin, &id, &0);
        client.deactivate_project(&admin, &id, &1);
        let result = client.try_deactivate_project(&admin, &id, &2);
        assert_eq!(result, Err(Ok(RegistryError::InvalidStatusTransition)));
    }

    #[test]
    fn test_deactivate_not_found() {
        let (_env, client, admin, _user) = setup();
        let result = client.try_deactivate_project(&admin, &999, &0);
        assert_eq!(result, Err(Ok(RegistryError::ProjectNotFound)));
    }

    #[test]
    fn test_resubmit_project() {
        let (env, client, admin, user) = setup();
        let hash = create_hash(&env, 1);
        let id = client.register_project(
            &user,
            &hash,
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );
        client.reject_project(&admin, &id, &0);
        let new_hash = create_hash(&env, 2);
        client.resubmit_project(&user, &id, &new_hash, &1);
        let project = client.get_project(&id);
        assert_eq!(project.status, ProjectStatus::Pending);
        assert_eq!(project.metadata_ipfs_hash, new_hash);
        assert_eq!(project.id, id);
        assert_eq!(project.owner, user);
    }

    #[test]
    fn test_resubmit_requires_owner() {
        let (env, client, admin, user) = setup();
        let other = Address::generate(&env);
        let hash = create_hash(&env, 1);
        let id = client.register_project(
            &user,
            &hash,
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );
        client.reject_project(&admin, &id, &0);
        let new_hash = create_hash(&env, 2);
        let result = client.try_resubmit_project(&other, &id, &new_hash, &0);
        assert_eq!(result, Err(Ok(RegistryError::Unauthorized)));
    }

    #[test]
    fn test_resubmit_pending_fails() {
        let (env, client, _admin, user) = setup();
        let hash = create_hash(&env, 1);
        let id = client.register_project(
            &user,
            &hash,
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );
        let new_hash = create_hash(&env, 2);
        let result = client.try_resubmit_project(&user, &id, &new_hash, &1);
        assert_eq!(result, Err(Ok(RegistryError::InvalidStatusTransition)));
    }

    #[test]
    fn test_resubmit_approved_fails() {
        let (env, client, admin, user) = setup();
        let hash = create_hash(&env, 1);
        let id = client.register_project(
            &user,
            &hash,
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );
        client.approve_project(&admin, &id, &0);
        let new_hash = create_hash(&env, 2);
        let result = client.try_resubmit_project(&user, &id, &new_hash, &1);
        assert_eq!(result, Err(Ok(RegistryError::InvalidStatusTransition)));
    }

    #[test]
    fn test_has_approved_project() {
        let (env, client, admin, user) = setup();
        let hash = create_hash(&env, 1);
        let id = client.register_project(
            &user,
            &hash,
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );
        let key = client.project_key(&id);
        assert!(!client.has_approved_project(&key));
        client.approve_project(&admin, &id, &0);
        assert!(client.has_approved_project(&key));
        client.deactivate_project(&admin, &id, &1);
        assert!(!client.has_approved_project(&key));
    }

    #[test]
    fn test_project_key() {
        let (env, client, _admin, user) = setup();
        let hash = create_hash(&env, 1);
        let id = client.register_project(
            &user,
            &hash,
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );
        let key = client.project_key(&id);
        // key should match internal encoding (first 8 bytes = id BE)
        let expected = {
            let mut arr = [0u8; 32];
            arr[..8].copy_from_slice(&id.to_be_bytes());
            BytesN::from_array(&env, &arr)
        };
        assert_eq!(key, expected);
    }
}
