terraform {
  required_version = ">= 1.11.0"
  required_providers {
    nebius = {
      source  = "nebius/nebius"
      version = ">= 0.6.60"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.6.0"
    }
  }
}
