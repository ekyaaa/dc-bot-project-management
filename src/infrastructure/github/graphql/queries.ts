/**
 * GraphQL queries and mutations for GitHub Projects v2 integration.
 */

export const GET_ORG_PROJECT_V2_METADATA = /* GraphQL */ `
  query GetOrgProjectV2Metadata($owner: String!, $number: Int!) {
    organization(login: $owner) {
      projectV2(number: $number) {
        id
        title
        number
        fields(first: 50) {
          nodes {
            ... on ProjectV2SingleSelectField {
              id
              name
              options {
                id
                name
              }
            }
            ... on ProjectV2Field {
              id
              name
              dataType
            }
          }
        }
      }
    }
  }
`;

export const GET_USER_PROJECT_V2_METADATA = /* GraphQL */ `
  query GetUserProjectV2Metadata($owner: String!, $number: Int!) {
    user(login: $owner) {
      projectV2(number: $number) {
        id
        title
        number
        fields(first: 50) {
          nodes {
            ... on ProjectV2SingleSelectField {
              id
              name
              options {
                id
                name
              }
            }
            ... on ProjectV2Field {
              id
              name
              dataType
            }
          }
        }
      }
    }
  }
`;

export const GET_PROJECT_V2_ITEMS = /* GraphQL */ `
  query GetProjectV2Items($projectId: ID!, $cursor: String) {
    node(id: $projectId) {
      ... on ProjectV2 {
        id
        title
        number
        items(first: 100, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            type
            fieldValues(first: 20) {
              nodes {
                __typename
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  optionId
                  field {
                    ... on ProjectV2SingleSelectField {
                      id
                      name
                    }
                  }
                }
                ... on ProjectV2ItemFieldTextValue {
                  text
                  field {
                    ... on ProjectV2Field {
                      id
                      name
                    }
                  }
                }
              }
            }
            content {
              __typename
              ... on Issue {
                id
                number
                title
                body
                url
                state
                author {
                  login
                }
                assignees(first: 10) {
                  nodes {
                    id
                    login
                    databaseId
                  }
                }
                labels(first: 20) {
                  nodes {
                    name
                  }
                }
                comments {
                  totalCount
                }
                createdAt
                updatedAt
              }
              ... on PullRequest {
                id
                number
                title
                url
                state
                isDraft
                author {
                  login
                }
                assignees(first: 10) {
                  nodes {
                    id
                    login
                    databaseId
                  }
                }
                createdAt
                updatedAt
              }
            }
          }
        }
      }
    }
  }
`;

export const GET_ISSUE_PROJECT_ITEM = /* GraphQL */ `
  query GetIssueProjectItem($owner: String!, $repo: String!, $issueNumber: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $issueNumber) {
        id
        number
        title
        body
        url
        state
        author {
          login
        }
        assignees(first: 10) {
          nodes {
            id
            login
            databaseId
          }
        }
        labels(first: 20) {
          nodes {
            name
          }
        }
        comments(last: 5) {
          nodes {
            body
            createdAt
          }
          totalCount
        }
        createdAt
        updatedAt
        projectItems(first: 10) {
          nodes {
            id
            project {
              ... on ProjectV2 {
                id
                number
              }
            }
            fieldValues(first: 20) {
              nodes {
                __typename
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  optionId
                  field {
                    ... on ProjectV2SingleSelectField {
                      id
                      name
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

export const ADD_PROJECT_V2_ITEM_BY_ID = /* GraphQL */ `
  mutation AddProjectV2ItemById($projectId: ID!, $contentId: ID!) {
    addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
      item {
        id
      }
    }
  }
`;

export const UPDATE_PROJECT_V2_ITEM_FIELD_VALUE = /* GraphQL */ `
  mutation UpdateProjectV2ItemFieldValue(
    $projectId: ID!
    $itemId: ID!
    $fieldId: ID!
    $optionId: String!
  ) {
    updateProjectV2ItemFieldValue(
      input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: {
          singleSelectOptionId: $optionId
        }
      }
    ) {
      projectV2Item {
        id
      }
    }
  }
`;
