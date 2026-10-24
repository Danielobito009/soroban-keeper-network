import { UsageError, type ParsedValues, type CommandContext } from "../../args.js";
import { resolveSigner } from "../session.js";

/**
 * The keeper a read-only command looks at: `--keeper`, else the address of the
 * signing key if one is configured.
 */
export async function keeperToLookUp(
  values: ParsedValues,
  context: CommandContext,
): Promise<string> {
  const flag = values.keeper as string | undefined;
  if (flag !== undefined) return flag;
  const signing = await resolveSigner(values, context);
  if (signing === undefined) {
    throw new UsageError(
      "say which keeper to look at with --keeper <G...>, or set a signing key (--key-file, --identity, or SKN_SECRET_KEY)",
    );
  }
  return signing.address;
}
