// The container app itself. Expects infra/base.bicep to have been deployed to the same resource group.

@description('Container app name: lower-case letters, digits and hyphens, max 32 characters.')
param appName string

param location string = resourceGroup().location

@description('Full image reference, e.g. <registry>.azurecr.io/caex:<git sha>')
param image string

@description('Application (client) ID of the multi-tenant app registration')
param clientId string

@secure()
@description('Client secret VALUE of the app registration')
param clientSecret string

@description('Your bilan.com Directory (tenant) ID. Only this tenant can sign in.')
param partnerTenantId string

@description('IANA time zone used for "remove after" dates')
param timeZone string = 'America/New_York'

var suffix = uniqueString(resourceGroup().id)
var name = toLower(appName)

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: 'acr${suffix}'
}

resource env 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: 'cae-usa-only-ca'
}

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: name
  location: location
  properties: {
    managedEnvironmentId: env.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        {
          server: acr.properties.loginServer
          username: acr.listCredentials().username
          passwordSecretRef: 'acr-password'
        }
      ]
      secrets: [
        { name: 'acr-password', value: acr.listCredentials().passwords[0].value }
        { name: 'client-secret', value: clientSecret }
      ]
    }
    template: {
      containers: [
        {
          name: 'app'
          image: image
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          env: [
            { name: 'AZURE_CLIENT_ID', value: clientId }
            { name: 'AZURE_CLIENT_SECRET', secretRef: 'client-secret' }
            { name: 'PARTNER_TENANT_ID', value: partnerTenantId }
            { name: 'BASE_URL', value: 'https://${name}.${env.properties.defaultDomain}' }
            { name: 'HOST', value: '0.0.0.0' }
            { name: 'PORT', value: '8080' }
            { name: 'TRUST_PROXY', value: 'true' }
            { name: 'APP_TIMEZONE', value: timeZone }
            { name: 'DATA_DIR', value: '/data' }
          ]
          volumeMounts: [
            { volumeName: 'data', mountPath: '/data' }
          ]
          probes: [
            { type: 'Liveness', httpGet: { path: '/healthz', port: 8080 }, periodSeconds: 30 }
            { type: 'Readiness', httpGet: { path: '/healthz', port: 8080 }, periodSeconds: 10 }
          ]
        }
      ]
      // Exactly one replica, always on: the data is one JSON file and this replica runs the expiry sweep.
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
      volumes: [
        { name: 'data', storageType: 'AzureFile', storageName: 'data' }
      ]
    }
  }
}

output url string = 'https://${app.properties.configuration.ingress.fqdn}'
