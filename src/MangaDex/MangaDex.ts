import { SourceInfo, ContentRating, Source, Chapter, ChapterDetails, Manga, PagedResults, SearchRequest, Section, MangaStatus } from 'paperback-extensions-common';

export const MangaDexInfo: SourceInfo = {
    name: "MangaDex",
    description: "MangaDex source for nullium21's own use",
    version: "0.1.0",
    author: "nullium21",
    websiteBaseURL: "https://mangadex.org",
    contentRating: ContentRating.EVERYONE,
    icon: "icon.png"
};

interface MDContentRating {
    id: string;
    name: string;
    isHentai: boolean;
}

export class MangaDex extends Source {
    stateManager = createSourceStateManager({});

    requestManager = createRequestManager({
        requestsPerSecond: 4,
        requestTimeout: 20000
    });

    static statuses: Map<string, MangaStatus> = new Map([
        ["completed", MangaStatus.COMPLETED],
        ["ongoing", MangaStatus.ONGOING],
        ["cancelled", MangaStatus.ABANDONED],
        ["hiatus", MangaStatus.HIATUS]
    ]);

    static contentRatings: MDContentRating[] = [
        { id: "safe", name: "Safe", isHentai: false },
        { id: "suggestive", name: "Suggestive", isHentai: false },
        { id: "erotica", name: "Erotica", isHentai: true },
        { id: "pornographic", name: "Pornographic/Hentai", isHentai: true }
    ];

    static isHentai(rating: string | MDContentRating): boolean {
        if (typeof rating === 'string') {
            const matching = this.contentRatings.find(r => r.id === rating);
            if (matching === undefined) return true; // failsafe
            rating = matching;
        }

        return rating.isHentai;
    }

    async getSettings() {
        const language = (await this.stateManager.retrieve('language') as string) ?? 'en';

        const ratings: [string, boolean][] = await Promise.all(
            MangaDex.contentRatings.map(async (rating) => [
                rating.id,
                await this.stateManager.retrieve(`contentRating-${rating.id}`) as boolean
            ])
        );

        const contentRatings = new Map<string, boolean>(ratings);

        return { language, contentRatings };
    }

    async allowedContentRatings() {
        const fromSettings = (await this.getSettings()).contentRatings;

        return MangaDex.contentRatings
            .filter(r => fromSettings.get(r.id) ?? false);
    }

    override async getSourceMenu(): Promise<Section> {
        return createSection({
            id: "main",
            header: "Source Settings",
            rows: async () => this.getSettings().then(settings => [
                createInputField({
                    id: "language",
                    label: "Preferred Langauge",
                    placeholder: "en",
                    value: settings.language,
                    maskInput: false
                }),
                ...MangaDex.contentRatings
                    .map(rating => createSwitch({
                        id: `contentRating-${rating.id}`,
                        label: rating.name,
                        value: settings.contentRatings.get(rating.id) ?? true
                    }))
            ])
        });
    }

    async getMangaDetails(mangaId: string): Promise<Manga> {
        const [response] = await Promise.all([
            this.requestManager.schedule(createRequestObject({
                url: `https://api.mangadex.org/manga/${mangaId}`,
                method: 'GET',
                param: `?includes[]=cover_art`
            }), 1)
        ]);

        const result = (typeof response.data === 'string'
            ? JSON.parse(response.data) : response.data).data;
        
        const settings = await this.getSettings();
        const titles = [result.attributes.title, ...result.attributes.altTitles]
            .map(x => x[settings.language])
            .filter(x => x);
        
        const description = result.attributes.description[settings.language];

        const coverArts = result.relationships
            .filter((x: any) => x.type === 'cover_art')
            .map((x: any) => `https://mangadex.org/covers/${x.attributes.fileName}`);

        const isHentai = MangaDex.isHentai(result.attributes.hentai);

        return createManga({
            id: mangaId,
            titles,
            image: coverArts[0],
            status: MangaDex.statuses.get(result.attributes.status) ?? MangaStatus.UNKNOWN,
            desc: description,
            covers: coverArts,
            lastUpdate: new Date(result.attributes.updatedAt),
            hentai: isHentai
        });
    }

    async getChapters(mangaId: string): Promise<Chapter[]> {
        const settings = await this.getSettings();

        const [response] = await Promise.all([
            this.requestManager.schedule(createRequestObject({
                url: 'https://api.mangadex.org/chapter',
                method: 'GET',
                param: `?limit=100&manga=${mangaId}&${
                    (await this.allowedContentRatings())
                        .map(r => `contentRatings[]=${r.id}`)
                        .join('&')
                    }`
            }), 1)
        ]);

        const result: any[] = (typeof response.data === 'string'
            ? JSON.parse(response.data) : response.data).data;
        
        const results = result.flatMap(({ id, attributes: ch }) => {
            if (settings.language && settings.language !== ch.translatedLanguage)
                return [];
            return createChapter({
                id,
                mangaId,
                chapNum: parseInt(ch.chapter),
                langCode: ch.translatedLanguage,
                name: ch.title,
                volume: ch.volume
            });
        });

        const filtered = new Map<string, Chapter>(results.map(r => [`${r.langCode}-${r.volume ?? 'unknown'}-${r.chapNum}`, r]));
        return [...filtered.values()];
    }

    async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        const [response] = await Promise.all([
            this.requestManager.schedule(createRequestObject({
                url: `https://api.mangadex.org/at-home/server/${chapterId}`,
                method: 'GET'
            }), 1)
        ]);

        const { baseUrl, chapter: { data: pageFilenames, hash } } = (typeof response.data === 'string'
            ? JSON.parse(response.data) : response.data);
        
        return createChapterDetails({
            id: chapterId, mangaId,
            pages: (pageFilenames as string[]).map(x => `${baseUrl}/data/${hash}/${x}`),
            longStrip: false
        });
    }

    async getSearchResults(query: SearchRequest, metadata: any): Promise<PagedResults> {
        const [response] = await Promise.all([
            this.requestManager.schedule(createRequestObject({
                url: 'https://api.mangadex.org/manga',
                method: 'GET',
                param: `title=${encodeURIComponent(query.title ?? '')}&${
                    (await this.allowedContentRatings())
                        .map(r => `contentRatings[]=${r.id}`)
                        .join('&')
                    }&includes[]=manga&includes[]=cover_art`
            }), 1)
        ]);

        const settings = await this.getSettings();

        const { data: found } = (typeof response.data === 'string'
            ? JSON.parse(response.data) : response.data);
        
        return createPagedResults({
            results: (found as any[]).map(({ id, attributes: manga, relationships }) => {
                const covers = (relationships as any[]).filter(x => x.type === 'cover_art');

                return createMangaTile({
                    id,
                    title: createIconText({ text: manga.title[settings.language] ?? manga.altTitles[settings.language] ?? 'Unknown Manga' }),
                    image: `https://mangadex.org/covers/${covers[0].attributes.fileName}`
                });
            })
        })
    }
}