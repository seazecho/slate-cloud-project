terraform {
  required_version = ">= 1.5.0"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.90"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.5"
    }
  }
}

provider "azurerm" {
  features {
    resource_group {
      prevent_deletion_if_contains_resources = false
    }
  }
}

resource "random_string" "suffix" {
  length  = 6
  special = false
  upper   = false
}

# -----------------------------------------------------------------------------
# 1. Resource Group (In India)
# -----------------------------------------------------------------------------
resource "azurerm_resource_group" "rg" {
  name     = "rg-slate-app-v3"
  location = "centralindia"

  tags = {
    project = "slate-cloud-project"
  }
}

# -----------------------------------------------------------------------------
# 2. Storage Account & Storage Queue (In India)
# -----------------------------------------------------------------------------
resource "azurerm_storage_account" "sa" {
  name                     = "stslateapp${random_string.suffix.result}"
  resource_group_name      = azurerm_resource_group.rg.name
  location                 = azurerm_resource_group.rg.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
}

resource "azurerm_storage_queue" "activity_events" {
  name                 = "activity-events"
  storage_account_name = azurerm_storage_account.sa.name
}

# -----------------------------------------------------------------------------
# 3. Cosmos DB (Serverless) (In India)
# -----------------------------------------------------------------------------
resource "azurerm_cosmosdb_account" "cosmos" {
  name                = "cosmos-slate-app-${random_string.suffix.result}"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  offer_type          = "Standard"
  kind                = "GlobalDocumentDB"

  capabilities {
    name = "EnableServerless"
  }

  consistency_policy {
    consistency_level = "Session"
  }

  geo_location {
    location          = azurerm_resource_group.rg.location
    failover_priority = 0
  }
}

resource "azurerm_cosmosdb_sql_database" "slate_db" {
  name                = "slate-db"
  resource_group_name = azurerm_resource_group.rg.name
  account_name        = azurerm_cosmosdb_account.cosmos.name
}

resource "azurerm_cosmosdb_sql_container" "logs" {
  name                = "logs"
  resource_group_name = azurerm_resource_group.rg.name
  account_name        = azurerm_cosmosdb_account.cosmos.name
  database_name       = azurerm_cosmosdb_sql_database.slate_db.name
  partition_key_paths = ["/userId"]
}

resource "azurerm_cosmosdb_sql_container" "feed" {
  name                = "feed"
  resource_group_name = azurerm_resource_group.rg.name
  account_name        = azurerm_cosmosdb_account.cosmos.name
  database_name       = azurerm_cosmosdb_sql_database.slate_db.name
  partition_key_paths = ["/ownerId"]
}

# -----------------------------------------------------------------------------
# 4. Function App (In India)
# -----------------------------------------------------------------------------
resource "azurerm_service_plan" "asp" {
  name                = "asp-slate-app"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  os_type             = "Windows"
  sku_name            = "Y1"
}

resource "azurerm_windows_function_app" "function_app" {
  name                       = "func-slate-app-${random_string.suffix.result}"
  resource_group_name        = azurerm_resource_group.rg.name
  location                   = azurerm_resource_group.rg.location
  storage_account_name       = azurerm_storage_account.sa.name
  storage_account_access_key = azurerm_storage_account.sa.primary_access_key
  service_plan_id            = azurerm_service_plan.asp.id

  site_config {
    application_stack {
      node_version = "~18"
    }
  }
}

# -----------------------------------------------------------------------------
# 5. Static Web App (Forced to East Asia to bypass restrictions)
# -----------------------------------------------------------------------------
resource "azurerm_static_web_app" "swa" {
  name                = "swa-slate-app-${random_string.suffix.result}"
  resource_group_name = azurerm_resource_group.rg.name
  location            = "eastasia"
  sku_tier            = "Free"
  sku_size            = "Free"
}

# -----------------------------------------------------------------------------
# Outputs
# -----------------------------------------------------------------------------
output "resource_group_name" {
  value = azurerm_resource_group.rg.name
}
output "storage_account_name" {
  value = azurerm_storage_account.sa.name
}
output "cosmosdb_account_name" {
  value = azurerm_cosmosdb_account.cosmos.name
}
output "function_app_name" {
  value = azurerm_windows_function_app.function_app.name
}
output "static_web_app_name" {
  value = azurerm_static_web_app.swa.name
}