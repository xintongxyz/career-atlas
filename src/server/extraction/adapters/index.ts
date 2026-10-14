import { ashbyAdapter } from "./ashby";
import { greenhouseAdapter } from "./greenhouse";
import { leverAdapter } from "./lever";
import { smartRecruitersAdapter } from "./smartrecruiters";
import type { Adapter } from "./types";
import { workdayAdapter } from "./workday";

export const ADAPTERS: Adapter[] = [greenhouseAdapter, leverAdapter, ashbyAdapter, smartRecruitersAdapter, workdayAdapter];
export type { Adapter, AdapterResult, JsonFetcher } from "./types";
