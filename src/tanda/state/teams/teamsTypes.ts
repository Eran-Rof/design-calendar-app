import type { DmConversation } from "../../../utils/tandaTypes";

export interface TeamsState {
  // Channel state
  teamsChannelMap: Record<string, { channelId: string; teamId: string }>;
  teamsTeamId: string;
  teamsSelPO: string | null;
  teamsMessages: Record<string, any[]>;
  teamsLoading: Record<string, boolean>;
  teamsCreating: string | null;
  teamsNewMsg: string;
  teamsAuthStatus: "idle" | "loading" | "error";
  teamsSearchPO: string;
  // Direct messaging
  teamsDirectTo: string;
  teamsDirectMsg: string;
  teamsDirectSending: boolean;
  teamsDirectErr: string | null;
  teamsTab: "channels" | "direct";
  dmConversations: DmConversation[];
  dmActiveChatId: string | null;
  dmComposing: boolean;
  dmSelectedName: string;
  dmLoading: boolean;
  dmError: string | null;
  dmNewMsg: string;
  dmSending: boolean;
  // Contacts
  teamsContacts: any[];
  teamsContactsLoading: boolean;
  teamsContactSearch: string;
  teamsContactDropdown: boolean;
  teamsContactSearchResults: any[];
  teamsContactSearchLoading: boolean;
  teamsContactsError: string | null;
  // Detail-panel DM
  dtlDMTo: string;
  dtlDMMsg: string;
  dtlDMSending: boolean;
  dtlDMErr: string | null;
  dtlDMContactSearch: string;
  dtlDMContactDropdown: boolean;
  dtlDMContactSearchResults: any[];
  dtlDMContactSearchLoading: boolean;
}

export type TeamsAction =
  | { type: "SET"; field: keyof TeamsState; value: any }
  | { type: "TEAMS_RESET_DM" }
  | { type: "TEAMS_RESET_DTL_DM" };

export const initialTeamsState: TeamsState = {
  teamsChannelMap: {},
  teamsTeamId: "",
  teamsSelPO: null,
  teamsMessages: {},
  teamsLoading: {},
  teamsCreating: null,
  teamsNewMsg: "",
  teamsAuthStatus: "idle",
  teamsSearchPO: "",
  teamsDirectTo: "",
  teamsDirectMsg: "",
  teamsDirectSending: false,
  teamsDirectErr: null,
  teamsTab: "channels",
  dmConversations: [],
  dmActiveChatId: null,
  dmComposing: true,
  dmSelectedName: "",
  dmLoading: false,
  dmError: null,
  dmNewMsg: "",
  dmSending: false,
  teamsContacts: [],
  teamsContactsLoading: false,
  teamsContactSearch: "",
  teamsContactDropdown: false,
  teamsContactSearchResults: [],
  teamsContactSearchLoading: false,
  teamsContactsError: null,
  dtlDMTo: "",
  dtlDMMsg: "",
  dtlDMSending: false,
  dtlDMErr: null,
  dtlDMContactSearch: "",
  dtlDMContactDropdown: false,
  dtlDMContactSearchResults: [],
  dtlDMContactSearchLoading: false,
};
