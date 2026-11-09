// USA-only Conditional Access Exclusion on Azure App Service (Linux) with the client secret in Key Vault.
// Deploy with infra/deploy.ps1 (or: az deployment group create -g <rg> -f infra/main.bicep -p ...).

@description('Web app name. Must be globally unique; the default address is https://<name>.azurewebsites.net')
param appName string

param location string = resourceGroup().location

@description('Application (client) ID of the multi-tenant app registration')
param clientId string

@secure()
@description('Client secret VALUE of the app registration. Stored in Key Vault, never in app settings.')
param clientSecret string

@description('Your bilan.com Directory (tenant) ID. Only this tenant can sign in.')
param partnerTenantId string

@description('App Service plan size. Needs Basic or higher so Always On keeps the expiry sweep running.')
param sku string = 'B1'

var vaultName = take('kv-${replace(appName, '-', '')}-${uniqueString(resourceGroup().id)}', 24)

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: '${appName}-plan'
  location: location
  kind: 'linux'
  sku: {
    name: sku
    capacity: 1 // keep at 1: data lives in a JSON file and one instance runs the expiry sweep
  }
  properties: {
    reserved: true
  }
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: vaultName
  location: location
  properties: {
    tenantId: tenant().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enableSoftDelete: true
  }
}

resource secret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'client-secret'
  properties: {
    value: clientSecret
  }
}

resource app 'Microsoft.Web/sites@2023-12-01' = {
  name: appName
  location: location
  kind: 'app,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'NODE|22-lts'
      alwaysOn: true
      healthCheckPath: '/healthz'
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      appSettings: [
        { name: 'AZURE_CLIENT_ID', value: clientId }
        { name: 'AZURE_CLIENT_SECRET', value: '@Microsoft.KeyVault(SecretUri=${secret.properties.secretUri})' }
        { name: 'PARTNER_TENANT_ID', value: partnerTenantId }
        { name: 'DATA_DIR', value: '/home/data' } // /home persists across restarts and deployments
        { name: 'WEBSITES_ENABLE_APP_SERVICE_STORAGE', value: 'true' }
        { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'true' } // runs npm install on deploy
      ]
    }
  }
}

// Let the web app read secrets from the vault (built-in role: Key Vault Secrets User).
resource secretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, app.id, 'key-vault-secrets-user')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0f94b8d3c3bf')
    principalId: app.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

output siteUrl string = 'https://${app.properties.defaultHostName}'
output signInRedirectUri string = 'https://${app.properties.defaultHostName}/auth/callback'
output consentRedirectUri string = 'https://${app.properties.defaultHostName}/consent-done.html'
