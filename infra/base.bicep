// Shared resources for the Container Apps deployment: image registry, persistent file share, and the
// Container Apps environment. Deployed by .github/workflows/deploy.yml before the app itself.

param location string = resourceGroup().location

var suffix = uniqueString(resourceGroup().id)
var acrName = 'acr${suffix}'
var storageName = 'st${suffix}'

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: acrName
  location: location
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: true // the container app pulls with the registry's own credentials
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: storageName
  location: location
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
  }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-01-01' = {
  parent: storage
  name: 'default'
}

// Holds db.json (tenants, tracked exclusions, activity log) and the session key.
resource share 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-01-01' = {
  parent: fileService
  name: 'data'
  properties: {
    shareQuota: 1
  }
}

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-usa-only-ca'
  location: location
  properties: {}
}

resource envStorage 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: env
  name: 'data'
  properties: {
    azureFile: {
      accountName: storage.name
      accountKey: storage.listKeys().keys[0].value
      shareName: share.name
      accessMode: 'ReadWrite'
    }
  }
}

output acrName string = acr.name
output acrLoginServer string = acr.properties.loginServer
output storageAccount string = storage.name
