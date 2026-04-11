/**
 * Tanda store — email slice.
 *
 * Mirrors the EmailContext + emailReducer state shape. Includes the
 * specialized merge / reset / toggle actions used by the inbox views.
 */
import type { StateCreator } from "zustand";
import type { EmailState } from "../state/email/emailTypes";
import { initialEmailState } from "../state/email/emailTypes";
import type { TandaStore } from "./index";

export interface EmailSlice extends EmailState {
  setEmailField: <K extends keyof EmailState>(field: K, value: EmailState[K]) => void;
  mergeEmailsMap: (key: string, emails: any[], append?: boolean) => void;
  mergeSentMap: (key: string, emails: any[]) => void;
  setEmailNextLink: (key: string, link: string | null) => void;
  emailResetCompose: () => void;
  emailResetDetail: () => void;
  toggleFlagged: (id: string) => void;
  toggleCollapsedMsg: (id: string) => void;
}

export const createEmailSlice: StateCreator<TandaStore, [], [], EmailSlice> = (set) => ({
  ...initialEmailState,

  setEmailField: (field, value) => set({ [field]: value } as any),

  mergeEmailsMap: (key, emails, append) => set((s) => {
    const prev = s.emailsMap[key] || [];
    return { emailsMap: { ...s.emailsMap, [key]: append ? [...prev, ...emails] : emails } };
  }),

  mergeSentMap: (key, emails) => set((s) => ({
    emailSentMap: { ...s.emailSentMap, [key]: emails },
  })),

  setEmailNextLink: (key, link) => set((s) => ({
    emailNextLinks: { ...s.emailNextLinks, [key]: link },
  })),

  emailResetCompose: () => set({
    emailComposeTo: "",
    emailComposeSubject: "",
    emailComposeBody: "",
    emailSendErr: null,
  }),

  emailResetDetail: () => set({
    dtlComposeTo: "",
    dtlComposeSubject: "",
    dtlComposeBody: "",
    dtlSendErr: null,
    dtlReply: "",
    dtlEmailSel: null,
    dtlEmailThread: [],
    dtlThreadLoading: false,
  }),

  toggleFlagged: (id) => set((s) => {
    const next = new Set(s.emailFlaggedSet);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return { emailFlaggedSet: next };
  }),

  toggleCollapsedMsg: (id) => set((s) => {
    const next = new Set(s.emailCollapsedMsgs);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return { emailCollapsedMsgs: next };
  }),
});
