
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "public": {
          Tables: {
            "audit_events": {
                  Row: {
                    "action": string,"actor_kind": string,"actor_user_id": string | null,"created_at": string,"details": NonNullable<Json>,"entity_id": string | null,"entity_type": string | null,"id": number,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "action": string,"actor_kind"?: string,"actor_user_id"?: string | null,"created_at"?: string,"details"?: NonNullable<Json>,"entity_id"?: string | null,"entity_type"?: string | null,"id"?: never,"workspace_id": string
                  }
                  Update: {
                    "action"?: string,"actor_kind"?: string,"actor_user_id"?: string | null,"created_at"?: string,"details"?: NonNullable<Json>,"entity_id"?: string | null,"entity_type"?: string | null,"id"?: never,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "audit_events_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"budget_reservations": {
                  Row: {
                    "amount_usd": number,"attempt_id": string,"campaign_day": string | null,"campaign_id": string | null,"closed_at": string | null,"connection_day": string,"connection_id": string,"created_at": string,"id": string,"is_final_check": boolean,"purpose": Database["public"]['Enums']["attempt_purpose"],"settled_cost_usd": number | null,"status": Database["public"]['Enums']["reservation_status"],"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "amount_usd": number,"attempt_id": string,"campaign_day"?: string | null,"campaign_id"?: string | null,"closed_at"?: string | null,"connection_day": string,"connection_id": string,"created_at"?: string,"id"?: string,"is_final_check"?: boolean,"purpose": Database["public"]['Enums']["attempt_purpose"],"settled_cost_usd"?: number | null,"status"?: Database["public"]['Enums']["reservation_status"],"workspace_id": string
                  }
                  Update: {
                    "amount_usd"?: number,"attempt_id"?: string,"campaign_day"?: string | null,"campaign_id"?: string | null,"closed_at"?: string | null,"connection_day"?: string,"connection_id"?: string,"created_at"?: string,"id"?: string,"is_final_check"?: boolean,"purpose"?: Database["public"]['Enums']["attempt_purpose"],"settled_cost_usd"?: number | null,"status"?: Database["public"]['Enums']["reservation_status"],"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "budget_reservations_workspace_id_attempt_id_fkey"
      columns: ["workspace_id","attempt_id"]
isOneToOne: false
      referencedRelation: "provider_attempts"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "budget_reservations_workspace_id_campaign_id_fkey"
      columns: ["workspace_id","campaign_id"]
isOneToOne: false
      referencedRelation: "campaigns"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "budget_reservations_workspace_id_connection_id_fkey"
      columns: ["workspace_id","connection_id"]
isOneToOne: false
      referencedRelation: "provider_connections"
      referencedColumns: ["workspace_id","id"]
    }
                  ]
                },"campaign_revision_step_templates": {
                  Row: {
                    "id": string,"position": number,"revision_id": string,"step_index": number,"template_id": string,"template_version_id": string | null,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "id"?: string,"position": number,"revision_id": string,"step_index": number,"template_id": string,"template_version_id"?: string | null,"workspace_id": string
                  }
                  Update: {
                    "id"?: string,"position"?: number,"revision_id"?: string,"step_index"?: number,"template_id"?: string,"template_version_id"?: string | null,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "campaign_revision_step_templa_template_id_template_version_fkey"
      columns: ["template_id","template_version_id"]
isOneToOne: false
      referencedRelation: "template_versions"
      referencedColumns: ["template_id","id"]
    },{
      foreignKeyName: "campaign_revision_step_templates_revision_id_step_index_fkey"
      columns: ["revision_id","step_index"]
isOneToOne: false
      referencedRelation: "campaign_revision_steps"
      referencedColumns: ["revision_id","step_index"]
    },{
      foreignKeyName: "campaign_revision_step_templates_workspace_id_revision_id_fkey"
      columns: ["workspace_id","revision_id"]
isOneToOne: false
      referencedRelation: "campaign_revisions"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "campaign_revision_step_templates_workspace_id_template_id_fkey"
      columns: ["workspace_id","template_id"]
isOneToOne: false
      referencedRelation: "templates"
      referencedColumns: ["workspace_id","id"]
    }
                  ]
                },"campaign_revision_steps": {
                  Row: {
                    "id": string,"kind": Database["public"]['Enums']["template_kind"],"label": string | null,"revision_id": string,"step_index": number,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "id"?: string,"kind": Database["public"]['Enums']["template_kind"],"label"?: string | null,"revision_id": string,"step_index": number,"workspace_id": string
                  }
                  Update: {
                    "id"?: string,"kind"?: Database["public"]['Enums']["template_kind"],"label"?: string | null,"revision_id"?: string,"step_index"?: number,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "campaign_revision_steps_workspace_id_revision_id_fkey"
      columns: ["workspace_id","revision_id"]
isOneToOne: false
      referencedRelation: "campaign_revisions"
      referencedColumns: ["workspace_id","id"]
    }
                  ]
                },"campaign_revisions": {
                  Row: {
                    "active_end_minute": number | null,"active_start_minute": number | null,"active_weekdays": (number)[] | null,"baseline_samples": number | null,"business_aliases": (string)[],"business_name": string | null,"campaign_id": string,"catch_up_max_delay_minutes": number | null,"catch_up_max_per_day": number | null,"category": string | null,"check_max_output_tokens": number | null,"check_model": string | null,"check_params": Json | null,"check_price_id": string | null,"cohort_key": string | null,"comparison_group_id": string | null,"connection_id": string | null,"conversations_per_day": number | null,"created_at": string,"created_by": string | null,"daily_budget_usd": number | null,"daily_checks": number | null,"domain_aliases": (string)[],"effective_at": string | null,"end_at": string | null,"est_check_max_cost_usd": number | null,"est_run_max_cost_usd": number | null,"execution_mode": string,"final_check_set_aside_usd": number,"final_samples": number | null,"frozen_at": string | null,"frozen_by": string | null,"id": string,"jitter_seconds": number,"language": string | null,"location": string | null,"max_concurrency": number | null,"max_output_tokens": number | null,"missed_slot_behavior": string | null,"model": string | null,"model_params": NonNullable<Json>,"on_existing_inclusion": string | null,"price_id": string | null,"probe_set_id": string | null,"probe_set_version_id": string | null,"requests_per_minute": number | null,"revision_number": number,"schedule_end_mode": string,"selection_mode": string,"selection_seed": string | null,"start_at": string | null,"state": string,"timezone": string | null,"tokens_per_minute": number | null,"total_budget_usd": number | null,"total_conversation_limit": number | null,"updated_at": string,"validation": NonNullable<Json>,"website_url": string | null,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "active_end_minute"?: number | null,"active_start_minute"?: number | null,"active_weekdays"?: (number)[] | null,"baseline_samples"?: number | null,"business_aliases"?: (string)[],"business_name"?: string | null,"campaign_id": string,"catch_up_max_delay_minutes"?: number | null,"catch_up_max_per_day"?: number | null,"category"?: string | null,"check_max_output_tokens"?: number | null,"check_model"?: string | null,"check_params"?: Json | null,"check_price_id"?: string | null,"cohort_key"?: string | null,"comparison_group_id"?: string | null,"connection_id"?: string | null,"conversations_per_day"?: number | null,"created_at"?: string,"created_by"?: string | null,"daily_budget_usd"?: number | null,"daily_checks"?: number | null,"domain_aliases"?: (string)[],"effective_at"?: string | null,"end_at"?: string | null,"est_check_max_cost_usd"?: number | null,"est_run_max_cost_usd"?: number | null,"execution_mode"?: string,"final_check_set_aside_usd"?: number,"final_samples"?: number | null,"frozen_at"?: string | null,"frozen_by"?: string | null,"id"?: string,"jitter_seconds"?: number,"language"?: string | null,"location"?: string | null,"max_concurrency"?: number | null,"max_output_tokens"?: number | null,"missed_slot_behavior"?: string | null,"model"?: string | null,"model_params"?: NonNullable<Json>,"on_existing_inclusion"?: string | null,"price_id"?: string | null,"probe_set_id"?: string | null,"probe_set_version_id"?: string | null,"requests_per_minute"?: number | null,"revision_number": number,"schedule_end_mode"?: string,"selection_mode"?: string,"selection_seed"?: string | null,"start_at"?: string | null,"state"?: string,"timezone"?: string | null,"tokens_per_minute"?: number | null,"total_budget_usd"?: number | null,"total_conversation_limit"?: number | null,"updated_at"?: string,"validation"?: NonNullable<Json>,"website_url"?: string | null,"workspace_id": string
                  }
                  Update: {
                    "active_end_minute"?: number | null,"active_start_minute"?: number | null,"active_weekdays"?: (number)[] | null,"baseline_samples"?: number | null,"business_aliases"?: (string)[],"business_name"?: string | null,"campaign_id"?: string,"catch_up_max_delay_minutes"?: number | null,"catch_up_max_per_day"?: number | null,"category"?: string | null,"check_max_output_tokens"?: number | null,"check_model"?: string | null,"check_params"?: Json | null,"check_price_id"?: string | null,"cohort_key"?: string | null,"comparison_group_id"?: string | null,"connection_id"?: string | null,"conversations_per_day"?: number | null,"created_at"?: string,"created_by"?: string | null,"daily_budget_usd"?: number | null,"daily_checks"?: number | null,"domain_aliases"?: (string)[],"effective_at"?: string | null,"end_at"?: string | null,"est_check_max_cost_usd"?: number | null,"est_run_max_cost_usd"?: number | null,"execution_mode"?: string,"final_check_set_aside_usd"?: number,"final_samples"?: number | null,"frozen_at"?: string | null,"frozen_by"?: string | null,"id"?: string,"jitter_seconds"?: number,"language"?: string | null,"location"?: string | null,"max_concurrency"?: number | null,"max_output_tokens"?: number | null,"missed_slot_behavior"?: string | null,"model"?: string | null,"model_params"?: NonNullable<Json>,"on_existing_inclusion"?: string | null,"price_id"?: string | null,"probe_set_id"?: string | null,"probe_set_version_id"?: string | null,"requests_per_minute"?: number | null,"revision_number"?: number,"schedule_end_mode"?: string,"selection_mode"?: string,"selection_seed"?: string | null,"start_at"?: string | null,"state"?: string,"timezone"?: string | null,"tokens_per_minute"?: number | null,"total_budget_usd"?: number | null,"total_conversation_limit"?: number | null,"updated_at"?: string,"validation"?: NonNullable<Json>,"website_url"?: string | null,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "campaign_revisions_check_price_id_fkey"
      columns: ["check_price_id"]
isOneToOne: false
      referencedRelation: "model_prices"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "campaign_revisions_group_fk"
      columns: ["workspace_id","comparison_group_id"]
isOneToOne: false
      referencedRelation: "comparison_groups"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "campaign_revisions_price_id_fkey"
      columns: ["price_id"]
isOneToOne: false
      referencedRelation: "model_prices"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "campaign_revisions_workspace_id_campaign_id_fkey"
      columns: ["workspace_id","campaign_id"]
isOneToOne: false
      referencedRelation: "campaigns"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "campaign_revisions_workspace_id_connection_id_fkey"
      columns: ["workspace_id","connection_id"]
isOneToOne: false
      referencedRelation: "provider_connections"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "campaign_revisions_workspace_id_probe_set_id_fkey"
      columns: ["workspace_id","probe_set_id"]
isOneToOne: false
      referencedRelation: "probe_sets"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "campaign_revisions_workspace_id_probe_set_version_id_fkey"
      columns: ["workspace_id","probe_set_version_id"]
isOneToOne: false
      referencedRelation: "probe_set_versions"
      referencedColumns: ["workspace_id","id"]
    }
                  ]
                },"campaigns": {
                  Row: {
                    "active_revision_id": string | null,"archived_at": string | null,"baseline_completed_at": string | null,"canceled_at": string | null,"canceled_by": string | null,"completed_at": string | null,"conversations_ended_at": string | null,"created_at": string,"created_by": string | null,"description": string | null,"draft_revision_id": string | null,"final_checks_started_at": string | null,"id": string,"launched_at": string | null,"launched_by": string | null,"name": string,"pause_detail": string | null,"pause_reason": string | null,"paused_from": Database["public"]['Enums']["campaign_status"] | null,"planned_through": string | null,"started_at": string | null,"status": Database["public"]['Enums']["campaign_status"],"updated_at": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "active_revision_id"?: string | null,"archived_at"?: string | null,"baseline_completed_at"?: string | null,"canceled_at"?: string | null,"canceled_by"?: string | null,"completed_at"?: string | null,"conversations_ended_at"?: string | null,"created_at"?: string,"created_by"?: string | null,"description"?: string | null,"draft_revision_id"?: string | null,"final_checks_started_at"?: string | null,"id"?: string,"launched_at"?: string | null,"launched_by"?: string | null,"name": string,"pause_detail"?: string | null,"pause_reason"?: string | null,"paused_from"?: Database["public"]['Enums']["campaign_status"] | null,"planned_through"?: string | null,"started_at"?: string | null,"status"?: Database["public"]['Enums']["campaign_status"],"updated_at"?: string,"workspace_id": string
                  }
                  Update: {
                    "active_revision_id"?: string | null,"archived_at"?: string | null,"baseline_completed_at"?: string | null,"canceled_at"?: string | null,"canceled_by"?: string | null,"completed_at"?: string | null,"conversations_ended_at"?: string | null,"created_at"?: string,"created_by"?: string | null,"description"?: string | null,"draft_revision_id"?: string | null,"final_checks_started_at"?: string | null,"id"?: string,"launched_at"?: string | null,"launched_by"?: string | null,"name"?: string,"pause_detail"?: string | null,"pause_reason"?: string | null,"paused_from"?: Database["public"]['Enums']["campaign_status"] | null,"planned_through"?: string | null,"started_at"?: string | null,"status"?: Database["public"]['Enums']["campaign_status"],"updated_at"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "campaigns_active_revision_fk"
      columns: ["id","active_revision_id"]
isOneToOne: false
      referencedRelation: "campaign_revisions"
      referencedColumns: ["campaign_id","id"]
    },{
      foreignKeyName: "campaigns_draft_revision_fk"
      columns: ["id","draft_revision_id"]
isOneToOne: false
      referencedRelation: "campaign_revisions"
      referencedColumns: ["campaign_id","id"]
    },{
      foreignKeyName: "campaigns_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"classifications": {
                  Row: {
                    "attempt_id": string | null,"campaign_id": string,"created_at": string,"created_by": string | null,"detector_version": string | null,"id": string,"inclusion": string,"is_current": boolean,"list_kind": string,"list_length": number | null,"list_position": number | null,"matched_spans": NonNullable<Json>,"mentioned": boolean,"method": string,"note": string | null,"rank": number | null,"reason": string | null,"subject_id": string,"subject_type": string,"supersedes_id": string | null,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attempt_id"?: string | null,"campaign_id": string,"created_at"?: string,"created_by"?: string | null,"detector_version"?: string | null,"id"?: string,"inclusion": string,"is_current"?: boolean,"list_kind"?: string,"list_length"?: number | null,"list_position"?: number | null,"matched_spans"?: NonNullable<Json>,"mentioned": boolean,"method": string,"note"?: string | null,"rank"?: number | null,"reason"?: string | null,"subject_id": string,"subject_type": string,"supersedes_id"?: string | null,"workspace_id": string
                  }
                  Update: {
                    "attempt_id"?: string | null,"campaign_id"?: string,"created_at"?: string,"created_by"?: string | null,"detector_version"?: string | null,"id"?: string,"inclusion"?: string,"is_current"?: boolean,"list_kind"?: string,"list_length"?: number | null,"list_position"?: number | null,"matched_spans"?: NonNullable<Json>,"mentioned"?: boolean,"method"?: string,"note"?: string | null,"rank"?: number | null,"reason"?: string | null,"subject_id"?: string,"subject_type"?: string,"supersedes_id"?: string | null,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "classifications_supersedes_id_fkey"
      columns: ["supersedes_id"]
isOneToOne: false
      referencedRelation: "classifications"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "classifications_workspace_id_campaign_id_fkey"
      columns: ["workspace_id","campaign_id"]
isOneToOne: false
      referencedRelation: "campaigns"
      referencedColumns: ["workspace_id","id"]
    }
                  ]
                },"comparison_groups": {
                  Row: {
                    "baseline_samples": number,"campaign_id": string,"created_at": string,"daily_checks": number,"final_samples": number,"first_revision_id": string | null,"id": string,"max_output_tokens": number,"model": string,"params": NonNullable<Json>,"probe_set_version_id": string,"selection_seed": string,"sequence": number,"signature": string,"started_mid_campaign": boolean,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "baseline_samples": number,"campaign_id": string,"created_at"?: string,"daily_checks": number,"final_samples": number,"first_revision_id"?: string | null,"id"?: string,"max_output_tokens": number,"model": string,"params"?: NonNullable<Json>,"probe_set_version_id": string,"selection_seed": string,"sequence": number,"signature": string,"started_mid_campaign"?: boolean,"workspace_id": string
                  }
                  Update: {
                    "baseline_samples"?: number,"campaign_id"?: string,"created_at"?: string,"daily_checks"?: number,"final_samples"?: number,"first_revision_id"?: string | null,"id"?: string,"max_output_tokens"?: number,"model"?: string,"params"?: NonNullable<Json>,"probe_set_version_id"?: string,"selection_seed"?: string,"sequence"?: number,"signature"?: string,"started_mid_campaign"?: boolean,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "comparison_groups_workspace_id_campaign_id_fkey"
      columns: ["workspace_id","campaign_id"]
isOneToOne: false
      referencedRelation: "campaigns"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "comparison_groups_workspace_id_probe_set_version_id_fkey"
      columns: ["workspace_id","probe_set_version_id"]
isOneToOne: false
      referencedRelation: "probe_set_versions"
      referencedColumns: ["workspace_id","id"]
    }
                  ]
                },"fresh_checks": {
                  Row: {
                    "attempt_count": number,"cache_write_tokens": number | null,"cached_input_tokens": number | null,"campaign_id": string,"classification_id": string | null,"comparison_group_id": string,"completed_at": string | null,"connection_id": string,"content_purged_at": string | null,"cost_usd": number | null,"created_at": string,"exclusion_reason": string | null,"execution_mode": string,"id": string,"inclusion": string | null,"incomplete_reason": string | null,"input_tokens": number | null,"is_held_out": boolean,"job_id": string,"latency_ms": number | null,"list_position": number | null,"local_day": string,"max_output_tokens": number,"mentioned": boolean | null,"model": string,"output_items": Json | null,"output_text": string | null,"output_tokens": number | null,"params": NonNullable<Json>,"phase": Database["public"]['Enums']["check_phase"],"price_id": string | null,"probe_question_id": string,"question_position": number,"rank": number | null,"reasoning_tokens": number | null,"refusal": boolean,"rendered_prompt": string | null,"response_id": string | null,"response_status": string | null,"returned_model": string | null,"revision_id": string,"scheduled_for": string | null,"service_tier": string | null,"started_at": string | null,"status": Database["public"]['Enums']["check_status"],"store_response": boolean,"total_tokens": number | null,"updated_at": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attempt_count"?: number,"cache_write_tokens"?: number | null,"cached_input_tokens"?: number | null,"campaign_id": string,"classification_id"?: string | null,"comparison_group_id": string,"completed_at"?: string | null,"connection_id": string,"content_purged_at"?: string | null,"cost_usd"?: number | null,"created_at"?: string,"exclusion_reason"?: string | null,"execution_mode"?: string,"id"?: string,"inclusion"?: string | null,"incomplete_reason"?: string | null,"input_tokens"?: number | null,"is_held_out": boolean,"job_id": string,"latency_ms"?: number | null,"list_position"?: number | null,"local_day": string,"max_output_tokens": number,"mentioned"?: boolean | null,"model": string,"output_items"?: Json | null,"output_text"?: string | null,"output_tokens"?: number | null,"params"?: NonNullable<Json>,"phase": Database["public"]['Enums']["check_phase"],"price_id"?: string | null,"probe_question_id": string,"question_position": number,"rank"?: number | null,"reasoning_tokens"?: number | null,"refusal"?: boolean,"rendered_prompt"?: string | null,"response_id"?: string | null,"response_status"?: string | null,"returned_model"?: string | null,"revision_id": string,"scheduled_for"?: string | null,"service_tier"?: string | null,"started_at"?: string | null,"status"?: Database["public"]['Enums']["check_status"],"store_response"?: boolean,"total_tokens"?: number | null,"updated_at"?: string,"workspace_id": string
                  }
                  Update: {
                    "attempt_count"?: number,"cache_write_tokens"?: number | null,"cached_input_tokens"?: number | null,"campaign_id"?: string,"classification_id"?: string | null,"comparison_group_id"?: string,"completed_at"?: string | null,"connection_id"?: string,"content_purged_at"?: string | null,"cost_usd"?: number | null,"created_at"?: string,"exclusion_reason"?: string | null,"execution_mode"?: string,"id"?: string,"inclusion"?: string | null,"incomplete_reason"?: string | null,"input_tokens"?: number | null,"is_held_out"?: boolean,"job_id"?: string,"latency_ms"?: number | null,"list_position"?: number | null,"local_day"?: string,"max_output_tokens"?: number,"mentioned"?: boolean | null,"model"?: string,"output_items"?: Json | null,"output_text"?: string | null,"output_tokens"?: number | null,"params"?: NonNullable<Json>,"phase"?: Database["public"]['Enums']["check_phase"],"price_id"?: string | null,"probe_question_id"?: string,"question_position"?: number,"rank"?: number | null,"reasoning_tokens"?: number | null,"refusal"?: boolean,"rendered_prompt"?: string | null,"response_id"?: string | null,"response_status"?: string | null,"returned_model"?: string | null,"revision_id"?: string,"scheduled_for"?: string | null,"service_tier"?: string | null,"started_at"?: string | null,"status"?: Database["public"]['Enums']["check_status"],"store_response"?: boolean,"total_tokens"?: number | null,"updated_at"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "fresh_checks_campaign_id_revision_id_fkey"
      columns: ["campaign_id","revision_id"]
isOneToOne: false
      referencedRelation: "campaign_revisions"
      referencedColumns: ["campaign_id","id"]
    },{
      foreignKeyName: "fresh_checks_price_id_fkey"
      columns: ["price_id"]
isOneToOne: false
      referencedRelation: "model_prices"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "fresh_checks_workspace_id_campaign_id_fkey"
      columns: ["workspace_id","campaign_id"]
isOneToOne: false
      referencedRelation: "campaigns"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "fresh_checks_workspace_id_comparison_group_id_fkey"
      columns: ["workspace_id","comparison_group_id"]
isOneToOne: false
      referencedRelation: "comparison_groups"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "fresh_checks_workspace_id_connection_id_fkey"
      columns: ["workspace_id","connection_id"]
isOneToOne: false
      referencedRelation: "provider_connections"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "fresh_checks_workspace_id_job_id_fkey"
      columns: ["workspace_id","job_id"]
isOneToOne: false
      referencedRelation: "jobs"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "fresh_checks_workspace_id_probe_question_id_fkey"
      columns: ["workspace_id","probe_question_id"]
isOneToOne: false
      referencedRelation: "probe_questions"
      referencedColumns: ["workspace_id","id"]
    }
                  ]
                },"jobs": {
                  Row: {
                    "attempts": number,"blocked_until": string | null,"campaign_id": string,"connection_id": string,"created_at": string,"dispatched_at": string | null,"fencing_token": number,"finished_at": string | null,"fresh_check_id": string | null,"id": string,"is_catch_up": boolean,"kind": Database["public"]['Enums']["job_kind"],"last_error_class": string | null,"last_error_message": string | null,"lease_expires_at": string | null,"lease_token": string | null,"leased_by": string | null,"max_attempts": number,"next_attempt_at": string | null,"queue_msg_id": number | null,"revision_id": string,"run_id": string | null,"scheduled_for": string,"slot_date": string,"slot_index": number,"status": Database["public"]['Enums']["job_status"],"status_reason": string | null,"updated_at": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attempts"?: number,"blocked_until"?: string | null,"campaign_id": string,"connection_id": string,"created_at"?: string,"dispatched_at"?: string | null,"fencing_token"?: number,"finished_at"?: string | null,"fresh_check_id"?: string | null,"id"?: string,"is_catch_up"?: boolean,"kind": Database["public"]['Enums']["job_kind"],"last_error_class"?: string | null,"last_error_message"?: string | null,"lease_expires_at"?: string | null,"lease_token"?: string | null,"leased_by"?: string | null,"max_attempts"?: number,"next_attempt_at"?: string | null,"queue_msg_id"?: number | null,"revision_id": string,"run_id"?: string | null,"scheduled_for": string,"slot_date": string,"slot_index": number,"status"?: Database["public"]['Enums']["job_status"],"status_reason"?: string | null,"updated_at"?: string,"workspace_id": string
                  }
                  Update: {
                    "attempts"?: number,"blocked_until"?: string | null,"campaign_id"?: string,"connection_id"?: string,"created_at"?: string,"dispatched_at"?: string | null,"fencing_token"?: number,"finished_at"?: string | null,"fresh_check_id"?: string | null,"id"?: string,"is_catch_up"?: boolean,"kind"?: Database["public"]['Enums']["job_kind"],"last_error_class"?: string | null,"last_error_message"?: string | null,"lease_expires_at"?: string | null,"lease_token"?: string | null,"leased_by"?: string | null,"max_attempts"?: number,"next_attempt_at"?: string | null,"queue_msg_id"?: number | null,"revision_id"?: string,"run_id"?: string | null,"scheduled_for"?: string,"slot_date"?: string,"slot_index"?: number,"status"?: Database["public"]['Enums']["job_status"],"status_reason"?: string | null,"updated_at"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "jobs_campaign_id_revision_id_fkey"
      columns: ["campaign_id","revision_id"]
isOneToOne: false
      referencedRelation: "campaign_revisions"
      referencedColumns: ["campaign_id","id"]
    },{
      foreignKeyName: "jobs_workspace_id_campaign_id_fkey"
      columns: ["workspace_id","campaign_id"]
isOneToOne: false
      referencedRelation: "campaigns"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "jobs_workspace_id_connection_id_fkey"
      columns: ["workspace_id","connection_id"]
isOneToOne: false
      referencedRelation: "provider_connections"
      referencedColumns: ["workspace_id","id"]
    }
                  ]
                },"manual_checks": {
                  Row: {
                    "campaign_id": string,"classification_id": string | null,"created_at": string,"id": string,"inclusion": string | null,"list_position": number | null,"mentioned": boolean | null,"observed_on": string,"question": string | null,"rank": number | null,"recorded_by": string | null,"response_text": string,"source_label": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "campaign_id": string,"classification_id"?: string | null,"created_at"?: string,"id"?: string,"inclusion"?: string | null,"list_position"?: number | null,"mentioned"?: boolean | null,"observed_on": string,"question"?: string | null,"rank"?: number | null,"recorded_by"?: string | null,"response_text": string,"source_label": string,"workspace_id": string
                  }
                  Update: {
                    "campaign_id"?: string,"classification_id"?: string | null,"created_at"?: string,"id"?: string,"inclusion"?: string | null,"list_position"?: number | null,"mentioned"?: boolean | null,"observed_on"?: string,"question"?: string | null,"rank"?: number | null,"recorded_by"?: string | null,"response_text"?: string,"source_label"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "manual_checks_workspace_id_campaign_id_fkey"
      columns: ["workspace_id","campaign_id"]
isOneToOne: false
      referencedRelation: "campaigns"
      referencedColumns: ["workspace_id","id"]
    }
                  ]
                },"model_prices": {
                  Row: {
                    "cache_write_12h_usd_per_mtok": number | null,"cache_write_30m_usd_per_mtok": number | null,"cached_input_usd_per_mtok": number | null,"created_at": string,"created_by": string | null,"id": string,"input_usd_per_mtok": number,"long_context_input_multiplier": number | null,"long_context_output_multiplier": number | null,"long_context_threshold_tokens": number | null,"model_id": string,"notes": string | null,"output_usd_per_mtok": number,"provider": string,"source_url": string,"verified_on": string,"version": number,"workspace_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "cache_write_12h_usd_per_mtok"?: number | null,"cache_write_30m_usd_per_mtok"?: number | null,"cached_input_usd_per_mtok"?: number | null,"created_at"?: string,"created_by"?: string | null,"id"?: string,"input_usd_per_mtok": number,"long_context_input_multiplier"?: number | null,"long_context_output_multiplier"?: number | null,"long_context_threshold_tokens"?: number | null,"model_id": string,"notes"?: string | null,"output_usd_per_mtok": number,"provider"?: string,"source_url": string,"verified_on": string,"version": number,"workspace_id"?: string | null
                  }
                  Update: {
                    "cache_write_12h_usd_per_mtok"?: number | null,"cache_write_30m_usd_per_mtok"?: number | null,"cached_input_usd_per_mtok"?: number | null,"created_at"?: string,"created_by"?: string | null,"id"?: string,"input_usd_per_mtok"?: number,"long_context_input_multiplier"?: number | null,"long_context_output_multiplier"?: number | null,"long_context_threshold_tokens"?: number | null,"model_id"?: string,"notes"?: string | null,"output_usd_per_mtok"?: number,"provider"?: string,"source_url"?: string,"verified_on"?: string,"version"?: number,"workspace_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "model_prices_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"probe_questions": {
                  Row: {
                    "body": string,"created_at": string,"id": string,"is_held_out": boolean,"position": number,"probe_set_version_id": string,"variables": (string)[],"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "body": string,"created_at"?: string,"id"?: string,"is_held_out"?: boolean,"position": number,"probe_set_version_id": string,"variables"?: (string)[],"workspace_id": string
                  }
                  Update: {
                    "body"?: string,"created_at"?: string,"id"?: string,"is_held_out"?: boolean,"position"?: number,"probe_set_version_id"?: string,"variables"?: (string)[],"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "probe_questions_workspace_id_probe_set_version_id_fkey"
      columns: ["workspace_id","probe_set_version_id"]
isOneToOne: false
      referencedRelation: "probe_set_versions"
      referencedColumns: ["workspace_id","id"]
    }
                  ]
                },"probe_set_versions": {
                  Row: {
                    "created_at": string,"created_by": string | null,"id": string,"probe_set_id": string,"version": number,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"id"?: string,"probe_set_id": string,"version": number,"workspace_id": string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"id"?: string,"probe_set_id"?: string,"version"?: number,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "probe_set_versions_workspace_id_probe_set_id_fkey"
      columns: ["workspace_id","probe_set_id"]
isOneToOne: false
      referencedRelation: "probe_sets"
      referencedColumns: ["workspace_id","id"]
    }
                  ]
                },"probe_sets": {
                  Row: {
                    "archived_at": string | null,"created_at": string,"created_by": string | null,"current_version_id": string | null,"description": string | null,"id": string,"name": string,"updated_at": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "archived_at"?: string | null,"created_at"?: string,"created_by"?: string | null,"current_version_id"?: string | null,"description"?: string | null,"id"?: string,"name": string,"updated_at"?: string,"workspace_id": string
                  }
                  Update: {
                    "archived_at"?: string | null,"created_at"?: string,"created_by"?: string | null,"current_version_id"?: string | null,"description"?: string | null,"id"?: string,"name"?: string,"updated_at"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "probe_sets_current_version_fk"
      columns: ["id","current_version_id"]
isOneToOne: false
      referencedRelation: "probe_set_versions"
      referencedColumns: ["probe_set_id","id"]
    },{
      foreignKeyName: "probe_sets_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"profiles": {
                  Row: {
                    "created_at": string,"display_name": string | null,"email": string,"id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"display_name"?: string | null,"email": string,"id": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"display_name"?: string | null,"email"?: string,"id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"provider_attempts": {
                  Row: {
                    "attempt_number": number,"cache_write_12h_tokens": number | null,"cache_write_30m_tokens": number | null,"cache_write_tokens": number | null,"cached_input_tokens": number | null,"campaign_id": string | null,"connection_id": string,"cost_usd": number | null,"created_by": string | null,"error_class": string | null,"error_code": string | null,"error_message": string | null,"error_param": string | null,"error_type": string | null,"est_input_tokens": number,"fencing_token": number | null,"finished_at": string | null,"fresh_check_id": string | null,"generation_id": string | null,"http_status": number | null,"id": string,"input_tokens": number | null,"is_test": boolean,"job_id": string | null,"last_polled_at": string | null,"latency_ms": number | null,"lease_token": string | null,"max_output_tokens": number,"mode": string,"output_tokens": number | null,"poll_count": number,"price_id": string | null,"provider_request_id": string | null,"purpose": Database["public"]['Enums']["attempt_purpose"],"reasoning_tokens": number | null,"request_params": NonNullable<Json>,"requested_model": string,"reservation_id": string | null,"resolution": string | null,"resolved_at": string | null,"resolved_by": string | null,"response_id": string | null,"response_status": string | null,"retry_after_ms": number | null,"returned_model": string | null,"run_id": string | null,"run_turn_id": string | null,"service_tier": string | null,"started_at": string,"status": Database["public"]['Enums']["attempt_status"],"total_tokens": number | null,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attempt_number"?: number,"cache_write_12h_tokens"?: number | null,"cache_write_30m_tokens"?: number | null,"cache_write_tokens"?: number | null,"cached_input_tokens"?: number | null,"campaign_id"?: string | null,"connection_id": string,"cost_usd"?: number | null,"created_by"?: string | null,"error_class"?: string | null,"error_code"?: string | null,"error_message"?: string | null,"error_param"?: string | null,"error_type"?: string | null,"est_input_tokens"?: number,"fencing_token"?: number | null,"finished_at"?: string | null,"fresh_check_id"?: string | null,"generation_id"?: string | null,"http_status"?: number | null,"id"?: string,"input_tokens"?: number | null,"is_test"?: boolean,"job_id"?: string | null,"last_polled_at"?: string | null,"latency_ms"?: number | null,"lease_token"?: string | null,"max_output_tokens"?: number,"mode"?: string,"output_tokens"?: number | null,"poll_count"?: number,"price_id"?: string | null,"provider_request_id"?: string | null,"purpose": Database["public"]['Enums']["attempt_purpose"],"reasoning_tokens"?: number | null,"request_params"?: NonNullable<Json>,"requested_model": string,"reservation_id"?: string | null,"resolution"?: string | null,"resolved_at"?: string | null,"resolved_by"?: string | null,"response_id"?: string | null,"response_status"?: string | null,"retry_after_ms"?: number | null,"returned_model"?: string | null,"run_id"?: string | null,"run_turn_id"?: string | null,"service_tier"?: string | null,"started_at"?: string,"status"?: Database["public"]['Enums']["attempt_status"],"total_tokens"?: number | null,"workspace_id": string
                  }
                  Update: {
                    "attempt_number"?: number,"cache_write_12h_tokens"?: number | null,"cache_write_30m_tokens"?: number | null,"cache_write_tokens"?: number | null,"cached_input_tokens"?: number | null,"campaign_id"?: string | null,"connection_id"?: string,"cost_usd"?: number | null,"created_by"?: string | null,"error_class"?: string | null,"error_code"?: string | null,"error_message"?: string | null,"error_param"?: string | null,"error_type"?: string | null,"est_input_tokens"?: number,"fencing_token"?: number | null,"finished_at"?: string | null,"fresh_check_id"?: string | null,"generation_id"?: string | null,"http_status"?: number | null,"id"?: string,"input_tokens"?: number | null,"is_test"?: boolean,"job_id"?: string | null,"last_polled_at"?: string | null,"latency_ms"?: number | null,"lease_token"?: string | null,"max_output_tokens"?: number,"mode"?: string,"output_tokens"?: number | null,"poll_count"?: number,"price_id"?: string | null,"provider_request_id"?: string | null,"purpose"?: Database["public"]['Enums']["attempt_purpose"],"reasoning_tokens"?: number | null,"request_params"?: NonNullable<Json>,"requested_model"?: string,"reservation_id"?: string | null,"resolution"?: string | null,"resolved_at"?: string | null,"resolved_by"?: string | null,"response_id"?: string | null,"response_status"?: string | null,"retry_after_ms"?: number | null,"returned_model"?: string | null,"run_id"?: string | null,"run_turn_id"?: string | null,"service_tier"?: string | null,"started_at"?: string,"status"?: Database["public"]['Enums']["attempt_status"],"total_tokens"?: number | null,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "provider_attempts_price_id_fkey"
      columns: ["price_id"]
isOneToOne: false
      referencedRelation: "model_prices"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "provider_attempts_reservation_fk"
      columns: ["reservation_id"]
isOneToOne: false
      referencedRelation: "budget_reservations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "provider_attempts_workspace_id_campaign_id_fkey"
      columns: ["workspace_id","campaign_id"]
isOneToOne: false
      referencedRelation: "campaigns"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "provider_attempts_workspace_id_connection_id_fkey"
      columns: ["workspace_id","connection_id"]
isOneToOne: false
      referencedRelation: "provider_connections"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "provider_attempts_workspace_id_job_id_fkey"
      columns: ["workspace_id","job_id"]
isOneToOne: false
      referencedRelation: "jobs"
      referencedColumns: ["workspace_id","id"]
    }
                  ]
                },"provider_connections": {
                  Row: {
                    "archived_at": string | null,"created_at": string,"created_by": string | null,"daily_budget_usd": number | null,"data_sharing": Database["public"]['Enums']["data_sharing_setting"],"data_sharing_note": string | null,"data_sharing_verified_on": string | null,"id": string,"key_hint": string | null,"key_set_at": string | null,"key_set_by": string | null,"last_ok_at": string | null,"last_tested_at": string | null,"max_concurrent_requests": number,"name": string,"provider": string,"requests_per_minute": number | null,"status": Database["public"]['Enums']["connection_status"],"status_code": string | null,"status_message": string | null,"store_fresh_check_responses": boolean,"tokens_per_minute": number | null,"total_budget_usd": number | null,"updated_at": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "archived_at"?: string | null,"created_at"?: string,"created_by"?: string | null,"daily_budget_usd"?: number | null,"data_sharing"?: Database["public"]['Enums']["data_sharing_setting"],"data_sharing_note"?: string | null,"data_sharing_verified_on"?: string | null,"id"?: string,"key_hint"?: string | null,"key_set_at"?: string | null,"key_set_by"?: string | null,"last_ok_at"?: string | null,"last_tested_at"?: string | null,"max_concurrent_requests"?: number,"name": string,"provider"?: string,"requests_per_minute"?: number | null,"status"?: Database["public"]['Enums']["connection_status"],"status_code"?: string | null,"status_message"?: string | null,"store_fresh_check_responses"?: boolean,"tokens_per_minute"?: number | null,"total_budget_usd"?: number | null,"updated_at"?: string,"workspace_id": string
                  }
                  Update: {
                    "archived_at"?: string | null,"created_at"?: string,"created_by"?: string | null,"daily_budget_usd"?: number | null,"data_sharing"?: Database["public"]['Enums']["data_sharing_setting"],"data_sharing_note"?: string | null,"data_sharing_verified_on"?: string | null,"id"?: string,"key_hint"?: string | null,"key_set_at"?: string | null,"key_set_by"?: string | null,"last_ok_at"?: string | null,"last_tested_at"?: string | null,"max_concurrent_requests"?: number,"name"?: string,"provider"?: string,"requests_per_minute"?: number | null,"status"?: Database["public"]['Enums']["connection_status"],"status_code"?: string | null,"status_message"?: string | null,"store_fresh_check_responses"?: boolean,"tokens_per_minute"?: number | null,"total_budget_usd"?: number | null,"updated_at"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "provider_connections_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"provider_models": {
                  Row: {
                    "capabilities": Json | null,"connection_id": string,"created_at": string,"id": string,"is_listed": boolean,"listed_at": string | null,"model_id": string,"owned_by": string | null,"provider_created_at": string | null,"shutdown_date": string | null,"updated_at": string,"verification_error": string | null,"verification_status": string,"verified_at": string | null,"verified_by": string | null,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "capabilities"?: Json | null,"connection_id": string,"created_at"?: string,"id"?: string,"is_listed"?: boolean,"listed_at"?: string | null,"model_id": string,"owned_by"?: string | null,"provider_created_at"?: string | null,"shutdown_date"?: string | null,"updated_at"?: string,"verification_error"?: string | null,"verification_status"?: string,"verified_at"?: string | null,"verified_by"?: string | null,"workspace_id": string
                  }
                  Update: {
                    "capabilities"?: Json | null,"connection_id"?: string,"created_at"?: string,"id"?: string,"is_listed"?: boolean,"listed_at"?: string | null,"model_id"?: string,"owned_by"?: string | null,"provider_created_at"?: string | null,"shutdown_date"?: string | null,"updated_at"?: string,"verification_error"?: string | null,"verification_status"?: string,"verified_at"?: string | null,"verified_by"?: string | null,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "provider_models_workspace_id_connection_id_fkey"
      columns: ["workspace_id","connection_id"]
isOneToOne: false
      referencedRelation: "provider_connections"
      referencedColumns: ["workspace_id","id"]
    }
                  ]
                },"run_turns": {
                  Row: {
                    "attempt_count": number,"cache_write_tokens": number | null,"cached_input_tokens": number | null,"campaign_id": string,"classification_id": string | null,"completed_at": string | null,"cost_usd": number | null,"created_at": string,"id": string,"inclusion": string | null,"incomplete_reason": string | null,"input_tokens": number | null,"latency_ms": number | null,"list_position": number | null,"mentioned": boolean | null,"output_items": Json | null,"output_text": string | null,"output_tokens": number | null,"previous_response_id": string | null,"rank": number | null,"reasoning_tokens": number | null,"refusal": boolean,"rendered_prompt": string | null,"request_params": Json | null,"requested_model": string | null,"response_id": string | null,"response_status": string | null,"returned_model": string | null,"run_id": string,"service_tier": string | null,"started_at": string | null,"status": Database["public"]['Enums']["turn_status"],"step_index": number,"step_kind": Database["public"]['Enums']["template_kind"],"template_id": string | null,"template_version_id": string | null,"total_tokens": number | null,"updated_at": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attempt_count"?: number,"cache_write_tokens"?: number | null,"cached_input_tokens"?: number | null,"campaign_id": string,"classification_id"?: string | null,"completed_at"?: string | null,"cost_usd"?: number | null,"created_at"?: string,"id"?: string,"inclusion"?: string | null,"incomplete_reason"?: string | null,"input_tokens"?: number | null,"latency_ms"?: number | null,"list_position"?: number | null,"mentioned"?: boolean | null,"output_items"?: Json | null,"output_text"?: string | null,"output_tokens"?: number | null,"previous_response_id"?: string | null,"rank"?: number | null,"reasoning_tokens"?: number | null,"refusal"?: boolean,"rendered_prompt"?: string | null,"request_params"?: Json | null,"requested_model"?: string | null,"response_id"?: string | null,"response_status"?: string | null,"returned_model"?: string | null,"run_id": string,"service_tier"?: string | null,"started_at"?: string | null,"status"?: Database["public"]['Enums']["turn_status"],"step_index": number,"step_kind": Database["public"]['Enums']["template_kind"],"template_id"?: string | null,"template_version_id"?: string | null,"total_tokens"?: number | null,"updated_at"?: string,"workspace_id": string
                  }
                  Update: {
                    "attempt_count"?: number,"cache_write_tokens"?: number | null,"cached_input_tokens"?: number | null,"campaign_id"?: string,"classification_id"?: string | null,"completed_at"?: string | null,"cost_usd"?: number | null,"created_at"?: string,"id"?: string,"inclusion"?: string | null,"incomplete_reason"?: string | null,"input_tokens"?: number | null,"latency_ms"?: number | null,"list_position"?: number | null,"mentioned"?: boolean | null,"output_items"?: Json | null,"output_text"?: string | null,"output_tokens"?: number | null,"previous_response_id"?: string | null,"rank"?: number | null,"reasoning_tokens"?: number | null,"refusal"?: boolean,"rendered_prompt"?: string | null,"request_params"?: Json | null,"requested_model"?: string | null,"response_id"?: string | null,"response_status"?: string | null,"returned_model"?: string | null,"run_id"?: string,"service_tier"?: string | null,"started_at"?: string | null,"status"?: Database["public"]['Enums']["turn_status"],"step_index"?: number,"step_kind"?: Database["public"]['Enums']["template_kind"],"template_id"?: string | null,"template_version_id"?: string | null,"total_tokens"?: number | null,"updated_at"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "run_turns_workspace_id_campaign_id_fkey"
      columns: ["workspace_id","campaign_id"]
isOneToOne: false
      referencedRelation: "campaigns"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "run_turns_workspace_id_run_id_fkey"
      columns: ["workspace_id","run_id"]
isOneToOne: false
      referencedRelation: "runs"
      referencedColumns: ["workspace_id","id"]
    }
                  ]
                },"runs": {
                  Row: {
                    "campaign_id": string,"cohort_key": string | null,"combination": Json | null,"combination_index": number | null,"completed_at": string | null,"connection_id": string,"content_purged_at": string | null,"created_at": string,"error_class": string | null,"error_message": string | null,"execution_mode": string | null,"id": string,"job_id": string,"kind": string,"last_response_at": string | null,"last_response_id": string | null,"max_output_tokens": number | null,"model": string | null,"model_params": Json | null,"on_existing_inclusion": string | null,"ordinal": number,"price_id": string | null,"restart_of_run_id": string | null,"revision_id": string,"scheduled_for": string | null,"selection_mode": string | null,"selection_seed": string | null,"started_at": string | null,"status": Database["public"]['Enums']["run_status"],"steps_completed": number,"steps_total": number | null,"target": Json | null,"target_in_first_response": boolean | null,"target_in_initial_prompt": boolean | null,"updated_at": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "campaign_id": string,"cohort_key"?: string | null,"combination"?: Json | null,"combination_index"?: number | null,"completed_at"?: string | null,"connection_id": string,"content_purged_at"?: string | null,"created_at"?: string,"error_class"?: string | null,"error_message"?: string | null,"execution_mode"?: string | null,"id"?: string,"job_id": string,"kind"?: string,"last_response_at"?: string | null,"last_response_id"?: string | null,"max_output_tokens"?: number | null,"model"?: string | null,"model_params"?: Json | null,"on_existing_inclusion"?: string | null,"ordinal": number,"price_id"?: string | null,"restart_of_run_id"?: string | null,"revision_id": string,"scheduled_for"?: string | null,"selection_mode"?: string | null,"selection_seed"?: string | null,"started_at"?: string | null,"status"?: Database["public"]['Enums']["run_status"],"steps_completed"?: number,"steps_total"?: number | null,"target"?: Json | null,"target_in_first_response"?: boolean | null,"target_in_initial_prompt"?: boolean | null,"updated_at"?: string,"workspace_id": string
                  }
                  Update: {
                    "campaign_id"?: string,"cohort_key"?: string | null,"combination"?: Json | null,"combination_index"?: number | null,"completed_at"?: string | null,"connection_id"?: string,"content_purged_at"?: string | null,"created_at"?: string,"error_class"?: string | null,"error_message"?: string | null,"execution_mode"?: string | null,"id"?: string,"job_id"?: string,"kind"?: string,"last_response_at"?: string | null,"last_response_id"?: string | null,"max_output_tokens"?: number | null,"model"?: string | null,"model_params"?: Json | null,"on_existing_inclusion"?: string | null,"ordinal"?: number,"price_id"?: string | null,"restart_of_run_id"?: string | null,"revision_id"?: string,"scheduled_for"?: string | null,"selection_mode"?: string | null,"selection_seed"?: string | null,"started_at"?: string | null,"status"?: Database["public"]['Enums']["run_status"],"steps_completed"?: number,"steps_total"?: number | null,"target"?: Json | null,"target_in_first_response"?: boolean | null,"target_in_initial_prompt"?: boolean | null,"updated_at"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "runs_campaign_id_revision_id_fkey"
      columns: ["campaign_id","revision_id"]
isOneToOne: false
      referencedRelation: "campaign_revisions"
      referencedColumns: ["campaign_id","id"]
    },{
      foreignKeyName: "runs_price_id_fkey"
      columns: ["price_id"]
isOneToOne: false
      referencedRelation: "model_prices"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "runs_workspace_id_campaign_id_fkey"
      columns: ["workspace_id","campaign_id"]
isOneToOne: false
      referencedRelation: "campaigns"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "runs_workspace_id_connection_id_fkey"
      columns: ["workspace_id","connection_id"]
isOneToOne: false
      referencedRelation: "provider_connections"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "runs_workspace_id_job_id_fkey"
      columns: ["workspace_id","job_id"]
isOneToOne: false
      referencedRelation: "jobs"
      referencedColumns: ["workspace_id","id"]
    }
                  ]
                },"template_versions": {
                  Row: {
                    "body": string,"created_at": string,"created_by": string | null,"id": string,"template_id": string,"variables": (string)[],"version": number,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "body": string,"created_at"?: string,"created_by"?: string | null,"id"?: string,"template_id": string,"variables"?: (string)[],"version": number,"workspace_id": string
                  }
                  Update: {
                    "body"?: string,"created_at"?: string,"created_by"?: string | null,"id"?: string,"template_id"?: string,"variables"?: (string)[],"version"?: number,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "template_versions_workspace_id_template_id_fkey"
      columns: ["workspace_id","template_id"]
isOneToOne: false
      referencedRelation: "templates"
      referencedColumns: ["workspace_id","id"]
    }
                  ]
                },"templates": {
                  Row: {
                    "archived_at": string | null,"collection": string | null,"created_at": string,"created_by": string | null,"current_version_id": string | null,"generation_id": string | null,"id": string,"kind": Database["public"]['Enums']["template_kind"],"label": string | null,"source": string,"updated_at": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "archived_at"?: string | null,"collection"?: string | null,"created_at"?: string,"created_by"?: string | null,"current_version_id"?: string | null,"generation_id"?: string | null,"id"?: string,"kind": Database["public"]['Enums']["template_kind"],"label"?: string | null,"source"?: string,"updated_at"?: string,"workspace_id": string
                  }
                  Update: {
                    "archived_at"?: string | null,"collection"?: string | null,"created_at"?: string,"created_by"?: string | null,"current_version_id"?: string | null,"generation_id"?: string | null,"id"?: string,"kind"?: Database["public"]['Enums']["template_kind"],"label"?: string | null,"source"?: string,"updated_at"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "templates_current_version_fk"
      columns: ["id","current_version_id"]
isOneToOne: false
      referencedRelation: "template_versions"
      referencedColumns: ["template_id","id"]
    },{
      foreignKeyName: "templates_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"usage_ledger": {
                  Row: {
                    "attempt_id": string,"basis": string,"cache_write_tokens": number,"cached_input_tokens": number,"campaign_day": string | null,"campaign_id": string | null,"connection_day": string,"connection_id": string,"cost_usd": number,"id": string,"input_tokens": number,"is_test": boolean,"model": string,"occurred_at": string,"output_tokens": number,"price_id": string | null,"purpose": Database["public"]['Enums']["attempt_purpose"],"reasoning_tokens": number,"returned_model": string | null,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attempt_id": string,"basis"?: string,"cache_write_tokens"?: number,"cached_input_tokens"?: number,"campaign_day"?: string | null,"campaign_id"?: string | null,"connection_day": string,"connection_id": string,"cost_usd": number,"id"?: string,"input_tokens"?: number,"is_test"?: boolean,"model": string,"occurred_at"?: string,"output_tokens"?: number,"price_id"?: string | null,"purpose": Database["public"]['Enums']["attempt_purpose"],"reasoning_tokens"?: number,"returned_model"?: string | null,"workspace_id": string
                  }
                  Update: {
                    "attempt_id"?: string,"basis"?: string,"cache_write_tokens"?: number,"cached_input_tokens"?: number,"campaign_day"?: string | null,"campaign_id"?: string | null,"connection_day"?: string,"connection_id"?: string,"cost_usd"?: number,"id"?: string,"input_tokens"?: number,"is_test"?: boolean,"model"?: string,"occurred_at"?: string,"output_tokens"?: number,"price_id"?: string | null,"purpose"?: Database["public"]['Enums']["attempt_purpose"],"reasoning_tokens"?: number,"returned_model"?: string | null,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "usage_ledger_price_id_fkey"
      columns: ["price_id"]
isOneToOne: false
      referencedRelation: "model_prices"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "usage_ledger_workspace_id_attempt_id_fkey"
      columns: ["workspace_id","attempt_id"]
isOneToOne: false
      referencedRelation: "provider_attempts"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "usage_ledger_workspace_id_campaign_id_fkey"
      columns: ["workspace_id","campaign_id"]
isOneToOne: false
      referencedRelation: "campaigns"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "usage_ledger_workspace_id_connection_id_fkey"
      columns: ["workspace_id","connection_id"]
isOneToOne: false
      referencedRelation: "provider_connections"
      referencedColumns: ["workspace_id","id"]
    }
                  ]
                },"variation_generations": {
                  Row: {
                    "campaign_id": string | null,"candidates": Json | null,"completed_at": string | null,"connection_id": string,"context": NonNullable<Json>,"created_at": string,"created_by": string | null,"error_message": string | null,"id": string,"kind": Database["public"]['Enums']["template_kind"],"model": string,"requested_count": number,"status": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "campaign_id"?: string | null,"candidates"?: Json | null,"completed_at"?: string | null,"connection_id": string,"context"?: NonNullable<Json>,"created_at"?: string,"created_by"?: string | null,"error_message"?: string | null,"id"?: string,"kind": Database["public"]['Enums']["template_kind"],"model": string,"requested_count": number,"status"?: string,"workspace_id": string
                  }
                  Update: {
                    "campaign_id"?: string | null,"candidates"?: Json | null,"completed_at"?: string | null,"connection_id"?: string,"context"?: NonNullable<Json>,"created_at"?: string,"created_by"?: string | null,"error_message"?: string | null,"id"?: string,"kind"?: Database["public"]['Enums']["template_kind"],"model"?: string,"requested_count"?: number,"status"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "variation_generations_workspace_id_connection_id_fkey"
      columns: ["workspace_id","connection_id"]
isOneToOne: false
      referencedRelation: "provider_connections"
      referencedColumns: ["workspace_id","id"]
    }
                  ]
                },"workspace_invitations": {
                  Row: {
                    "accepted_at": string | null,"accepted_by": string | null,"created_at": string,"email": string,"expires_at": string,"id": string,"invited_by": string | null,"role": Database["public"]['Enums']["workspace_role"],"status": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "accepted_at"?: string | null,"accepted_by"?: string | null,"created_at"?: string,"email": string,"expires_at"?: string,"id"?: string,"invited_by"?: string | null,"role": Database["public"]['Enums']["workspace_role"],"status"?: string,"workspace_id": string
                  }
                  Update: {
                    "accepted_at"?: string | null,"accepted_by"?: string | null,"created_at"?: string,"email"?: string,"expires_at"?: string,"id"?: string,"invited_by"?: string | null,"role"?: Database["public"]['Enums']["workspace_role"],"status"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "workspace_invitations_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"workspace_members": {
                  Row: {
                    "created_at": string,"invited_by": string | null,"role": Database["public"]['Enums']["workspace_role"],"user_id": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"invited_by"?: string | null,"role": Database["public"]['Enums']["workspace_role"],"user_id": string,"workspace_id": string
                  }
                  Update: {
                    "created_at"?: string,"invited_by"?: string | null,"role"?: Database["public"]['Enums']["workspace_role"],"user_id"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "workspace_members_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"workspaces": {
                  Row: {
                    "created_at": string,"created_by": string | null,"emergency_stop": boolean,"emergency_stop_at": string | null,"emergency_stop_by": string | null,"emergency_stop_reason": string | null,"id": string,"name": string,"retention_days": number | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"emergency_stop"?: boolean,"emergency_stop_at"?: string | null,"emergency_stop_by"?: string | null,"emergency_stop_reason"?: string | null,"id"?: string,"name": string,"retention_days"?: number | null,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"emergency_stop"?: boolean,"emergency_stop_at"?: string | null,"emergency_stop_by"?: string | null,"emergency_stop_reason"?: string | null,"id"?: string,"name"?: string,"retention_days"?: number | null,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "accept_pending_invitations":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"add_model_price":
{ Args: { "p_price": Json,"p_workspace_id": string }; Returns: string
                           },
"apply_campaign_changes":
{ Args: { "p_campaign_id": string,"p_expected_revision_id": string,"p_validation"?: Json }; Returns: Json
                           },
"archive_connection":
{ Args: { "p_connection_id": string }; Returns: undefined
                           },
"begin_campaign_edit":
{ Args: { "p_campaign_id": string }; Returns: string
                           },
"budget_status":
{ Args: { "p_workspace_id": string }; Returns: Json
                           },
"campaign_check_metrics":
{ Args: { "p_campaign_id": string }; Returns: {
              "canceled": number,"comparison_group_id": string,"excluded": number,"failed": number,"group_sequence": number,"included": number,"incomplete": number,"is_held_out": boolean,"local_day": string,"mentioned_only": number,"needs_review": number,"not_mentioned": number,"pending": number,"phase": Database["public"]['Enums']["check_phase"],"total": number,"valid": number
            }[]
                           },
"campaign_conversation_metrics":
{ Args: { "p_campaign_id": string }; Returns: {
              "cohort_key": string,"final_included": number,"final_mentioned_only": number,"final_needs_review": number,"final_not_mentioned": number,"final_valid": number,"first_included": number,"first_mentioned_only": number,"first_needs_review": number,"first_not_mentioned": number,"first_valid": number,"max_output_tokens": number,"model": string,"model_params": Json,"revision_numbers": (number)[],"runs_canceled": number,"runs_completed": number,"runs_completed_early": number,"runs_expired": number,"runs_failed": number,"runs_in_progress": number,"runs_incomplete": number,"runs_total": number,"runs_unresolved": number,"target_in_initial_prompt": number
            }[]
                           },
"campaign_daily_activity":
{ Args: { "p_campaign_id": string }; Returns: {
              "conversations_completed": number,"conversations_other": number,"cost_usd": number,"final_included": number,"final_valid": number,"local_day": string,"slots_skipped": number
            }[]
                           },
"campaign_launch_check":
{ Args: { "p_campaign_id": string }; Returns: Json
                           },
"campaign_plan_preview":
{ Args: { "p_campaign_id": string }; Returns: Json
                           },
"campaign_summaries":
{ Args: { "p_workspace_id": string }; Returns: {
              "archived_at": string,"business_name": string,"category": string,"checks_completed": number,"completed_at": string,"conversations_per_day": number,"conversations_planned": number,"created_at": string,"daily_budget_usd": number,"description": string,"end_at": string,"final_included": number,"final_valid": number,"first_included": number,"first_valid": number,"has_pending_changes": boolean,"id": string,"jobs_dead": number,"launched_at": string,"model": string,"name": string,"needs_review": number,"next_slot_at": string,"pause_detail": string,"pause_reason": string,"paused_from": Database["public"]['Enums']["campaign_status"],"revision_number": number,"runs_completed": number,"runs_in_progress": number,"runs_problem": number,"runs_total": number,"spend_total_usd": number,"start_at": string,"status": Database["public"]['Enums']["campaign_status"],"timezone": string,"total_budget_usd": number,"total_conversation_limit": number,"website_url": string
            }[]
                           },
"cancel_campaign":
{ Args: { "p_campaign_id": string }; Returns: undefined
                           },
"complete_owner_setup":
{ Args: { "p_workspace_name": string }; Returns: string
                           },
"correct_classification":
{ Args: { "p_inclusion": string,"p_list_position"?: number,"p_note"?: string,"p_rank"?: number,"p_subject_id": string,"p_subject_type": string }; Returns: string
                           },
"create_campaign":
{ Args: { "p_description"?: string,"p_name": string,"p_workspace_id": string }; Returns: string
                           },
"create_connection":
{ Args: { "p_daily_budget_usd": number,"p_max_concurrent_requests"?: number,"p_name": string,"p_requests_per_minute"?: number,"p_tokens_per_minute"?: number,"p_total_budget_usd"?: number,"p_workspace_id": string }; Returns: string
                           },
"create_templates":
{ Args: { "p_collection"?: string,"p_generation_id"?: string,"p_items": Json,"p_kind": Database["public"]['Enums']["template_kind"],"p_skip_duplicates"?: boolean,"p_source"?: string,"p_workspace_id": string }; Returns: (string)[]
                           },
"declare_data_sharing":
{ Args: { "p_connection_id": string,"p_note"?: string,"p_setting": Database["public"]['Enums']["data_sharing_setting"],"p_verified_on": string }; Returns: undefined
                           },
"delete_campaign":
{ Args: { "p_campaign_id": string }; Returns: undefined
                           },
"delete_manual_check":
{ Args: { "p_manual_check_id": string }; Returns: undefined
                           },
"delete_template":
{ Args: { "p_template_id": string }; Returns: undefined
                           },
"delete_workspace":
{ Args: { "p_confirm_name": string,"p_workspace_id": string }; Returns: undefined
                           },
"discard_campaign_draft":
{ Args: { "p_campaign_id": string }; Returns: undefined
                           },
"duplicate_campaign":
{ Args: { "p_campaign_id": string,"p_name"?: string }; Returns: string
                           },
"effective_prices":
{ Args: { "p_workspace_id": string }; Returns: {
              "cache_write_12h_usd_per_mtok": number | null,
"cache_write_30m_usd_per_mtok": number | null,
"cached_input_usd_per_mtok": number | null,
"created_at": string,
"created_by": string | null,
"id": string,
"input_usd_per_mtok": number,
"long_context_input_multiplier": number | null,
"long_context_output_multiplier": number | null,
"long_context_threshold_tokens": number | null,
"model_id": string,
"notes": string | null,
"output_usd_per_mtok": number,
"provider": string,
"source_url": string,
"verified_on": string,
"version": number,
"workspace_id": string | null
            }[]
                          SetofOptions: {
        from: "*"
        to: "model_prices"
        isOneToOne: false
        isSetofReturn: true
      } },
"launch_campaign":
{ Args: { "p_campaign_id": string,"p_expected_revision_id": string,"p_validation"?: Json }; Returns: Json
                           },
"operational_status":
{ Args: { "p_workspace_id": string }; Returns: Json
                           },
"overview_summary":
{ Args: { "p_workspace_id": string }; Returns: Json
                           },
"pause_campaign":
{ Args: { "p_campaign_id": string }; Returns: undefined
                           },
"record_manual_check":
{ Args: { "p_campaign_id": string,"p_classification": Json,"p_observed_on": string,"p_question": string,"p_response_text": string,"p_source_label": string }; Returns: string
                           },
"remove_member":
{ Args: { "p_user_id": string,"p_workspace_id": string }; Returns: undefined
                           },
"request_test_conversation":
{ Args: { "p_campaign_id": string }; Returns: string
                           },
"resolve_uncertain_attempt":
{ Args: { "p_attempt_id": string,"p_resolution": string }; Returns: undefined
                           },
"restart_run":
{ Args: { "p_run_id": string }; Returns: string
                           },
"resume_campaign":
{ Args: { "p_campaign_id": string }; Returns: undefined
                           },
"retry_job":
{ Args: { "p_job_id": string }; Returns: undefined
                           },
"revoke_invitation":
{ Args: { "p_invitation_id": string }; Returns: undefined
                           },
"save_campaign_draft":
{ Args: { "p_campaign_id": string,"p_patch": Json }; Returns: string
                           },
"save_probe_set":
{ Args: { "p_description": string,"p_name": string,"p_probe_set_id": string,"p_questions": Json,"p_workspace_id": string }; Returns: Json
                           },
"set_campaign_archived":
{ Args: { "p_archived": boolean,"p_campaign_id": string }; Returns: undefined
                           },
"set_emergency_stop":
{ Args: { "p_enabled": boolean,"p_reason"?: string,"p_workspace_id": string }; Returns: undefined
                           },
"set_probe_set_archived":
{ Args: { "p_archived": boolean,"p_probe_set_id": string }; Returns: undefined
                           },
"set_templates_archived":
{ Args: { "p_archived": boolean,"p_template_ids": (string)[] }; Returns: number
                           },
"setup_status":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"svc_attempt_in_flight":
{ Args: { "p_attempt_id": string,"p_fencing_token": number,"p_job_id": string,"p_lease_token": string,"p_poll_in_seconds"?: number,"p_response_id": string }; Returns: Json
                           },
"svc_begin_adhoc":
{ Args: { "p_actor": string,"p_campaign_id"?: string,"p_connection_id": string,"p_generation_id"?: string,"p_model": string,"p_purpose": Database["public"]['Enums']["attempt_purpose"],"p_requests": Json,"p_workspace_id": string }; Returns: Json
                           },
"svc_begin_attempt":
{ Args: { "p_est_input_tokens": number,"p_fencing_token": number,"p_job_id": string,"p_lease_token": string,"p_max_output_tokens": number,"p_mode": string,"p_now"?: string,"p_rendered_prompt"?: string,"p_request_params": Json }; Returns: Json
                           },
"svc_bootstrap_owner":
{ Args: { "p_email": string,"p_workspace_name"?: string }; Returns: Json
                           },
"svc_cancel_invitation":
{ Args: { "p_invitation_id": string,"p_reason": string }; Returns: undefined
                           },
"svc_commit_result":
{ Args: { "p_attempt_id": string,"p_classification"?: Json,"p_fencing_token": number,"p_job_id": string,"p_lease_token": string,"p_result": Json }; Returns: Json
                           },
"svc_configure_worker":
{ Args: { "p_functions_base_url": string,"p_worker_secret": string }; Returns: undefined
                           },
"svc_exclude_check":
{ Args: { "p_fencing_token": number,"p_job_id": string,"p_lease_token": string,"p_reason": string,"p_rendered_prompt"?: string }; Returns: Json
                           },
"svc_fail_attempt":
{ Args: { "p_attempt_id": string,"p_error": Json,"p_fencing_token": number,"p_job_id": string,"p_lease_token": string }; Returns: Json
                           },
"svc_finish_adhoc":
{ Args: { "p_attempt_id": string,"p_outcome": Json }; Returns: undefined
                           },
"svc_finish_generation":
{ Args: { "p_candidates": Json,"p_error"?: string,"p_generation_id": string }; Returns: undefined
                           },
"svc_get_connection_secret":
{ Args: { "p_connection_id": string }; Returns: string
                           },
"svc_invite_member":
{ Args: { "p_actor": string,"p_email": string,"p_role": Database["public"]['Enums']["workspace_role"],"p_workspace_id": string }; Returns: Json
                           },
"svc_materialize_run":
{ Args: { "p_fencing_token": number,"p_job_id": string,"p_lease_token": string,"p_plan": Json }; Returns: Json
                           },
"svc_member_role":
{ Args: { "p_user_id": string,"p_workspace_id": string }; Returns: Database["public"]['Enums']["workspace_role"]
                           },
"svc_poll_pending":
{ Args: { "p_attempt_id": string,"p_fencing_token": number,"p_job_id": string,"p_lease_token": string,"p_poll_in_seconds"?: number }; Returns: Json
                           },
"svc_receive_work":
{ Args: { "p_worker_id": string }; Returns: Json
                           },
"svc_record_connection_status":
{ Args: { "p_actor"?: string,"p_code"?: string,"p_connection_id": string,"p_message"?: string,"p_ok": boolean }; Returns: undefined
                           },
"svc_record_generation":
{ Args: { "p_actor": string,"p_campaign_id": string,"p_connection_id": string,"p_context": Json,"p_kind": Database["public"]['Enums']["template_kind"],"p_model": string,"p_requested_count": number,"p_workspace_id": string }; Returns: string
                           },
"svc_record_model_classification":
{ Args: { "p_actor": string,"p_attempt_id": string,"p_classification": Json,"p_subject_id": string,"p_subject_type": string }; Returns: string
                           },
"svc_release_work":
{ Args: { "p_delay_seconds"?: number,"p_fencing_token": number,"p_job_id": string,"p_lease_token": string }; Returns: Json
                           },
"svc_save_model_verification":
{ Args: { "p_actor": string,"p_capabilities": Json,"p_connection_id": string,"p_error"?: string,"p_model_id": string,"p_verified": boolean }; Returns: undefined
                           },
"svc_schedule_status":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"svc_store_connection_secret":
{ Args: { "p_actor": string,"p_api_key": string,"p_connection_id": string }; Returns: undefined
                           },
"svc_tick":
{ Args: { "p_now"?: string,"p_plan"?: boolean }; Returns: Json
                           },
"svc_upsert_provider_models":
{ Args: { "p_connection_id": string,"p_models": Json }; Returns: number
                           },
"svc_wake_check":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"svc_wake_result":
{ Args: { "p_request_id": number }; Returns: Json
                           },
"svc_worker_ready":
{ Args: Record<PropertyKey, never>; Returns: boolean
                           },
"templates_in_use":
{ Args: { "p_workspace_id": string }; Returns: (string)[]
                           },
"update_connection":
{ Args: { "p_connection_id": string,"p_patch": Json }; Returns: undefined
                           },
"update_member_role":
{ Args: { "p_role": Database["public"]['Enums']["workspace_role"],"p_user_id": string,"p_workspace_id": string }; Returns: undefined
                           },
"update_profile":
{ Args: { "p_display_name": string }; Returns: undefined
                           },
"update_template":
{ Args: { "p_body": string,"p_collection"?: string,"p_label"?: string,"p_template_id": string }; Returns: string
                           },
"update_workspace":
{ Args: { "p_name": string,"p_retention_days": number,"p_workspace_id": string }; Returns: undefined
                           },
"usage_daily":
{ Args: { "p_campaign_id"?: string,"p_from": string,"p_to": string,"p_workspace_id": string }; Returns: {
              "cached_input_tokens": number,"cost_usd": number,"input_tokens": number,"is_test": boolean,"model": string,"output_tokens": number,"purpose": Database["public"]['Enums']["attempt_purpose"],"reasoning_tokens": number,"requests": number,"usage_day": string
            }[]
                           },
"variation_coverage":
{ Args: { "p_campaign_id": string }; Returns: {
              "body": string,"in_current_revision": boolean,"step_index": number,"step_kind": Database["public"]['Enums']["template_kind"],"template_id": string,"uses": number
            }[]
                           }
          }
          Enums: {
            "attempt_purpose": "conversation_turn"|"fresh_check"|"model_probe"|"variation_generation"|"classification","attempt_status": "started"|"in_flight"|"succeeded"|"incomplete"|"failed"|"uncertain"|"canceled","campaign_status": "draft"|"scheduled"|"baseline"|"running"|"paused"|"finalizing"|"completed"|"canceled","check_phase": "baseline"|"daily"|"final","check_status": "pending"|"in_flight"|"completed"|"incomplete"|"failed"|"uncertain"|"canceled"|"excluded","connection_status": "not_configured"|"ok"|"error","data_sharing_setting": "enabled"|"disabled"|"unknown","job_kind": "conversation"|"check_baseline"|"check_daily"|"check_final"|"test_conversation","job_status": "pending"|"queued"|"running"|"waiting"|"paused"|"blocked"|"succeeded"|"dead"|"canceled"|"skipped","reservation_status": "held"|"settled"|"released"|"unresolved","run_status": "pending"|"in_progress"|"completed"|"completed_early"|"incomplete"|"failed"|"canceled"|"expired"|"unresolved","template_kind": "initial_question"|"inclusion_request"|"revision_request"|"extra_step"|"fresh_check","turn_status": "pending"|"in_flight"|"completed"|"incomplete"|"failed"|"uncertain"|"canceled"|"skipped","workspace_role": "owner"|"admin"|"member"
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "public": {
          Enums: {
            "attempt_purpose": ["conversation_turn", "fresh_check", "model_probe", "variation_generation", "classification"],"attempt_status": ["started", "in_flight", "succeeded", "incomplete", "failed", "uncertain", "canceled"],"campaign_status": ["draft", "scheduled", "baseline", "running", "paused", "finalizing", "completed", "canceled"],"check_phase": ["baseline", "daily", "final"],"check_status": ["pending", "in_flight", "completed", "incomplete", "failed", "uncertain", "canceled", "excluded"],"connection_status": ["not_configured", "ok", "error"],"data_sharing_setting": ["enabled", "disabled", "unknown"],"job_kind": ["conversation", "check_baseline", "check_daily", "check_final", "test_conversation"],"job_status": ["pending", "queued", "running", "waiting", "paused", "blocked", "succeeded", "dead", "canceled", "skipped"],"reservation_status": ["held", "settled", "released", "unresolved"],"run_status": ["pending", "in_progress", "completed", "completed_early", "incomplete", "failed", "canceled", "expired", "unresolved"],"template_kind": ["initial_question", "inclusion_request", "revision_request", "extra_step", "fresh_check"],"turn_status": ["pending", "in_flight", "completed", "incomplete", "failed", "uncertain", "canceled", "skipped"],"workspace_role": ["owner", "admin", "member"]
          }
        }
} as const
