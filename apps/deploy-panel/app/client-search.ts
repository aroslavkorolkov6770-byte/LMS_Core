type SearchableClient = { name: string; brandName: string; domain: string };

export function filterClients<T extends SearchableClient>(clients: readonly T[], query: string): readonly T[] {
  const terms = query.slice(0, 200).trim().toLocaleLowerCase("ru").split(/\s+/).filter(Boolean);
  if (!terms.length) return clients;
  return clients.filter((client) => {
    const text = `${client.name} ${client.brandName} ${client.domain}`.toLocaleLowerCase("ru");
    return terms.every((term) => text.includes(term));
  });
}
