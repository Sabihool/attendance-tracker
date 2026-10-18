/** Production wiring for the security services (tests build them with fakes). */
import User from "../models/User.js";
import College from "../models/College.js";
import { createAccountSecurityService } from "./accountSecurityService.js";

export const accountSecurityService = createAccountSecurityService({ User, College });
