export { localDatabase as testDatabase } from "../scripts/local-db";
import { localDatabase } from "../scripts/local-db";
/** Phase 14 R1: the analytical store, a separate database with its own migrations. */
export const analyticsDatabase = () => localDatabase(undefined, "db/analytics");
