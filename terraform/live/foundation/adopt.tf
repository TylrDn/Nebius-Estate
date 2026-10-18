# Adopt the state bucket and state identity that scripts/bootstrap-backend.sh created before the
# foundation existed (the documented first-deploy path), instead of failing on the name clash.
# The script prints the ids to paste into adopt_bootstrap. The group membership is adopted too: the
# API refuses a second membership ("Group membership already exists", live apply 2026-10-11). The
# bucket permit is re-created by Terraform; a duplicate permit is accepted and the script's copy can
# be removed.

import {
  for_each = { for s, a in var.adopt_bootstrap : s => a.bucket_id if a.bucket_id != null }
  to       = module.state_bucket[each.key].nebius_storage_v1_bucket.this
  id       = each.value
}

import {
  for_each = { for s, a in var.adopt_bootstrap : s => a.service_account_id if a.service_account_id != null }
  to       = module.state_identity[each.key].nebius_iam_v1_service_account.this
  id       = each.value
}

import {
  for_each = { for s, a in var.adopt_bootstrap : s => a.group_id if a.group_id != null }
  to       = module.state_identity[each.key].nebius_iam_v1_group.this
  id       = each.value
}

import {
  for_each = { for s, a in var.adopt_bootstrap : s => a.membership_id if a.membership_id != null }
  to       = module.state_identity[each.key].nebius_iam_v1_group_membership.this
  id       = each.value
}
